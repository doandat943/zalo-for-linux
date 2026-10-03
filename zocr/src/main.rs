#[cfg(not(all(target_os = "linux",
any(target_arch = "x86_64", target_arch = "aarch64"))))]
compile_error!("zocr-host supports Linux x86_64 and aarch64 only");
mod config;
mod engine;
mod image;
mod ipc;
mod platform;
mod runtime;
mod vault;
use anyhow::{bail, Context, Result};
use std::{path::PathBuf, sync::{atomic::Ordering, Arc, Mutex}};
fn main() {
    if let Err(error) = run() {
        eprintln!("[zocr-host] FATAL: {error:#}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        eprintln!("zocr-host [--socket-dir DIR]\nBinary IPC on stdin/stdout. Requires ZOCR_AUTH_TOKEN.\nPlace seed_key and text_digest_key (64 hex characters each), libonnxruntime.so and zocr/models.zmdl beside binary.");
        return Ok(());
    }
    let socket_dir =
        if args.is_empty() {
            std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(||
                    PathBuf::from("/tmp"))
        } else if args.len() == 2 && args[0] == "--socket-dir" {
            PathBuf::from(&args[1])
        } else { bail!("usage: zocr-host [--socket-dir DIR]"); };
    let stop = platform::lifecycle()?;
    if stop.load(Ordering::Relaxed) { return Ok(()); }
    // Restrict socket permissions from creation, including the bind/chmod interval.
    unsafe { libc::umask(0o077); }
    let cpu = platform::Cpu::discover()?;
    let cfg = config::Config::from_env(cpu.physical)?;
    platform::Cpu::gate(cfg.skip_cpu_gate)?;
    cpu.apply_affinity(&cfg.affinity)?;
    let dir =
        std::env::current_exe()?.parent().context("binary has no parent directory")?.to_path_buf();
    let engine =
        Arc::new(Mutex::new(engine::Engine::new(dir, cfg.clone(), cpu)?));
    let maintenance =
        platform::maintenance(engine.clone(), &cfg, stop.clone());
    let result = ipc::run(engine, cfg, stop.clone(), &socket_dir);
    stop.store(true, Ordering::Relaxed);
    let _ = maintenance.join();
    result
}
