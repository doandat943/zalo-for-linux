use anyhow::{ensure, Context, Result};
use serde_json::json;
use std::{
    fs, io::{self, BufReader, Read},
    net::Shutdown,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use crate::{config::Config, engine::Engine, image};
use super::{
    handshake, protocol::{self, RawHeader},
    reply, Output,
};
pub struct SocketServer {
    pub path: PathBuf,
    identity: (u64, u64),
    stop: Arc<AtomicBool>,
    active: Arc<Mutex<Option<UnixStream>>>,
    worker: Option<JoinHandle<()>>,
}
impl SocketServer {
    pub fn start(engine: Arc<Mutex<Engine>>, cfg: Config,
        global_stop: Arc<AtomicBool>, directory: &Path, token: String, output: Output) -> Result<Self> {
        let mut random = [0u8; 8];
        let mut read = 0;
        while read < random.len() {
            let n =
                unsafe {
                    libc::getrandom(random[read..].as_mut_ptr().cast(),
                        random.len() - read, 0)
                };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted { continue; }
                return Err(e.into());
            }
            ensure!(n>0,"getrandom returned no bytes");
            read += n as usize;
        }
        let path =
            directory.join(format!("zocr-{}.sock",hex::encode(random)));
        let listener =
            UnixListener::bind(&path).context("unable to bind Unix socket")?;
        let meta = fs::symlink_metadata(&path)?;
        let mut server =
            Self {
                path,
                identity: (meta.dev(), meta.ino()),
                stop: Arc::new(AtomicBool::new(false)),
                active: Arc::new(Mutex::new(None)),
                worker: None,
            };
        fs::set_permissions(&server.path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let token = zeroize::Zeroizing::new(token);
        let stop = server.stop.clone();
        let active = server.active.clone();
        server.worker =
            Some(thread::Builder::new().name("zocr-socket".into()).spawn(move
                            ||
                            {
                                while !stop.load(Ordering::Relaxed) &&
                                        !global_stop.load(Ordering::Relaxed) {
                                    match listener.accept() {
                                        Ok((stream, _)) => {
                                            if stop.load(Ordering::Relaxed) ||
                                                    global_stop.load(Ordering::Relaxed) {
                                                break;
                                            }
                                            if let Ok(clone) = stream.try_clone() {
                                                if let Ok(mut slot) = active.lock() { *slot = Some(clone); }
                                            }
                                            if let Err(error) =
                                                    serve(stream, &engine, &cfg, &stop, &global_stop, token.as_bytes(), &output) {
                                                if !stop.load(Ordering::Relaxed) &&
                                                        !global_stop.load(Ordering::Relaxed) {
                                                    eprintln!("[zocr-host] socket: {error:#}");
                                                }
                                            }
                                            if let Ok(mut slot) = active.lock() { *slot = None; }
                                        }
                                        Err(e) if e.kind() == io::ErrorKind::WouldBlock =>
                                            thread::sleep(Duration::from_millis(10)),
                                        Err(e) if e.kind() == io::ErrorKind::Interrupted =>
                                            continue,
                                        Err(e) => {
                                            eprintln!("[zocr-host] socket accept: {e}");
                                            break;
                                        }
                                    }
                                }
                            })?);
        Ok(server)
    }
}
impl Drop for SocketServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(slot) = self.active.lock() {
            if let Some(stream) = slot.as_ref() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
        // Do not unlink a different file that replaced our socket.
        if fs::symlink_metadata(&self.path).is_ok_and(|m|
                    (m.dev(), m.ino()) == self.identity) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn serve(mut stream: UnixStream, engine: &Arc<Mutex<Engine>>, cfg: &Config,
    stop: &AtomicBool, global_stop: &AtomicBool, token: &[u8], output: &Output) -> Result<()> {
    stream.set_read_timeout(Some(cfg.frame_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
    use std::os::fd::AsRawFd;
    ensure!(unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET,
        libc::SO_PEERCRED, (&mut credentials as *mut libc::ucred).cast(), &mut size) } == 0,
        "unable to read Unix socket peer credentials");
    let pid = credentials.pid as u32;
    let accepted = match handshake::verify(&mut stream, token) {
        Ok(accepted) => accepted,
        Err(error) => {
            super::event(output, 3, pid, &format!("handshake failed: {error}"))?;
            return Err(error.into());
        }
    };
    if !accepted {
        super::event(output, 3, pid, "handshake token mismatch")?;
        return Ok(());
    }
    super::event(output, 1, pid, "")?;
    let result = serve_frames(stream, engine, cfg, stop, global_stop);
    let detail = result.as_ref().err().map(|e| format!("{e:#}")).unwrap_or_default();
    super::event(output, 2, pid, &detail)?;
    result
}
fn serve_frames(stream: UnixStream, engine: &Arc<Mutex<Engine>>, cfg: &Config,
    stop: &AtomicBool, global_stop: &AtomicBool) -> Result<()> {
    let writer = stream.try_clone()?;
    // Buffer frames without conflating idle waiting with a partial-frame deadline.
    let mut reader = BufReader::with_capacity(cfg.pipe_buffer, stream);
    let mut writer = writer;
    loop {
        if stop.load(Ordering::Relaxed) || global_stop.load(Ordering::Relaxed)
            {
            return Ok(());
        }
        let mut header = [0u8; 27];
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(e) if
                matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::TimedOut|io::ErrorKind::Interrupted)
                => continue,
            Err(e) => return Err(e.into()),
        }
        let read_started = Instant::now();
        if let Err(e) = reader.read_exact(&mut header[1..]) {
            let _ =
                reply(&mut writer, protocol::ERR_DECODE,
                    &json!({"ok":false,"error":format!("incomplete raw header: {e}")}));
            return Ok(());
        }
        let raw =
            match RawHeader::parse(&header) {
                Ok(h) => h,
                Err(e) => {
                    reply(&mut writer, protocol::ERR_DECODE,
                            &json!({"ok":false,"error":e.to_string()}))?;
                    return Ok(());
                }
            };
        let mut data = vec![0;raw.size];
        if let Err(e) = reader.read_exact(&mut data) {
            let _ =
                reply(&mut writer, protocol::ERR_DECODE,
                    &json!({"ok":false,"error":format!("incomplete raw pixels: {e}")}));
            return Ok(());
        }
        let read_micros = read_started.elapsed().as_micros();
        let color_started = Instant::now();
        let image =
            match image::raw(&raw, &data) {
                Ok(i) => i,
                Err(e) => {
                    reply(&mut writer, protocol::ERR_DECODE,
                            &json!({"ok":false,"error":e.to_string()}))?;
                    continue;
                }
            };
        let color_micros = color_started.elapsed().as_micros();
        drop(data);
        if stop.load(Ordering::Relaxed) || global_stop.load(Ordering::Relaxed)
            {
            return Ok(());
        }
        let result =
            engine.lock().map_err(|_|
                            anyhow::anyhow!("engine mutex poisoned"))?.recognize(image);
        match result {
            Ok(mut value) => {
                super::input_profile(&mut value, cfg.benchmark_profile,
                    image::InputTimings {
                        read_micros,
                        decode_micros: 0,
                        color_micros,
                    });
                reply(&mut writer, protocol::OK, &value)?;
            }
            Err(e) =>
                reply(&mut writer, protocol::ERR_INFER,
                        &json!({"ok":false,"error":format!("{e:#}")}))?,
        }
    }
}
