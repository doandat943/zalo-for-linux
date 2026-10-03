pub mod protocol;
pub mod schema;
mod handshake;
mod unix_socket;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use crate::{config::Config, engine::Engine, image};
use unix_socket::SocketServer;
pub type Output = Arc<Mutex<io::Stdout>>;
pub fn reply(writer: &mut impl Write, _kind: u8, value: &Value) -> Result<()> {
    reply_generation(writer, 0, value)
}
fn reply_generation(writer: &mut impl Write, generation: u64, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let mut payload = generation.to_le_bytes().to_vec();
    payload.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    payload.extend_from_slice(&bytes);
    protocol::write_reply(writer, protocol::OK, &payload)?;
    Ok(())
}
pub fn event(output: &Output, kind: u8, pid: u32, detail: &str) -> Result<()> {
    let mut payload = vec![kind];
    payload.extend_from_slice(&pid.to_le_bytes());
    payload.extend_from_slice(&protocol::string_payload(detail));
    let mut writer = output.lock().map_err(|_| anyhow::anyhow!("stdout mutex poisoned"))?;
    protocol::write_reply(&mut *writer, protocol::PIPE_EVENT, &payload)?;
    Ok(())
}
struct Stdin {
    stop: Arc<AtomicBool>,
}
impl Read for Stdin {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() { return Ok(0); }
        loop {
            if self.stop.load(Ordering::Relaxed) {
                return Err(io::Error::new(io::ErrorKind::ConnectionAborted,
                            "shutdown"));
            }
            let mut fd =
                libc::pollfd {
                    fd: libc::STDIN_FILENO,
                    events: libc::POLLIN,
                    revents: 0,
                };
            let ready = unsafe { libc::poll(&mut fd, 1, 50) };
            if ready < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted { continue; }
                return Err(e);
            }
            if ready == 0 { continue; }
            let n =
                unsafe {
                    libc::read(libc::STDIN_FILENO, buffer.as_mut_ptr().cast(),
                        buffer.len())
                };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted { continue; }
                return Err(e);
            }
            return Ok(n as usize);
        }
    }
}
pub fn run(engine: Arc<Mutex<Engine>>, cfg: Config, stop: Arc<AtomicBool>,
    socket_directory: &Path) -> Result<()> {
    let mut stdin = Stdin { stop: stop.clone() };
    if !handshake::verify_control(&mut stdin, cfg.auth_token.as_bytes())? {
        bail!("handshake token mismatch");
    }
    eprintln!("OCR engine ready");
    let output = Arc::new(Mutex::new(io::stdout()));
    let mut server: Option<SocketServer> = None;
    while !stop.load(Ordering::Relaxed) {
        let frame = match protocol::read_envelope(&mut stdin) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(_) if stop.load(Ordering::Relaxed) => break,
            Err(error) => return Err(error.into()),
        };
        match frame.kind {
            protocol::PIPE_OPEN => {
                let result = (|| -> Result<Vec<u8>> {
                    let token = protocol::pipe_token(&frame.payload)?.to_owned();
                    if server.is_some() { bail!("pipe is already open"); }
                    let socket = SocketServer::start(engine.clone(), cfg.clone(),
                        stop.clone(), socket_directory, token, output.clone())?;
                    let mut payload = protocol::string_payload(&socket.path.to_string_lossy());
                    payload.extend_from_slice(&std::process::id().to_le_bytes());
                    server = Some(socket);
                    Ok(payload)
                })();
                let mut writer = output.lock().map_err(|_| anyhow::anyhow!("stdout mutex poisoned"))?;
                match result {
                    Ok(payload) => protocol::write_reply(&mut *writer, protocol::PIPE_READY, &payload)?,
                    Err(error) => protocol::write_reply(&mut *writer, protocol::PIPE_ERR,
                        &protocol::string_payload(&format!("{error:#}")))?,
                }
            }
            protocol::PIPE_CLOSE => {
                if !frame.payload.is_empty() { bail!("PIPE_CLOSE payload must be empty"); }
                server = None;
                event(&output, 4, 0, "")?;
            }
            protocol::PATH_REQUEST => {
                let value = (|| -> Result<Value> {
                    let path = PathBuf::from(protocol::image_path(&frame.payload)?);
                    let (image, timings) = image::read_profiled(&path)?;
                    let mut value = engine.lock().map_err(|_| anyhow::anyhow!("engine mutex poisoned"))?
                        .recognize(image)?;
                    input_profile(&mut value, cfg.benchmark_profile, timings);
                    Ok(value)
                })().unwrap_or_else(|error| json!({"ok":false,"error":format!("{error:#}")}));
                let mut writer = output.lock().map_err(|_| anyhow::anyhow!("stdout mutex poisoned"))?;
                reply(&mut *writer, protocol::OK, &value)?;
            }
            _ => bail!("unsupported command type {}", frame.kind),
        }
    }
    drop(server);
    Ok(())
}

pub(crate) fn input_profile(value: &mut Value, enabled: bool,
    timings: image::InputTimings) {
    if !enabled { return; }
    let stages = &mut value["result"]["meta"]["stages"];
    stages["readMicros"] = json!(timings.read_micros);
    stages["imageDecodeMicros"] = json!(timings.decode_micros);
    stages["colorConvertMicros"] = json!(timings.color_micros);
}
