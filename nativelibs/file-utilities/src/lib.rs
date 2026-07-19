#![cfg(target_os = "linux")]

use globset::Glob;
use lazy_static::lazy_static;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use walkdir::WalkDir;

lazy_static! {
  static ref JOBS: Mutex<HashMap<u64, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

#[napi(object)]
#[derive(Clone, Default)]
pub struct DirectorySizeOptions {
  pub workers: Option<u32>,
  pub job_id: Option<f64>,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct DirectoryTreeOptions {
  pub max_depth: Option<i32>,
  pub workers: Option<u32>,
  pub include_root: Option<bool>,
  pub job_id: Option<f64>,
}

#[napi(object)]
pub struct DirectorySizeResult {
  pub path: String,
  pub total_size: f64,
  pub file_count: f64,
  pub dir_count: f64,
  pub duration_ms: f64,
  pub workers: u32,
}

#[napi(object)]
pub struct DirectoryTreeNode {
  pub relative_path: String,
  pub depth: u32,
  pub total_size: f64,
  pub file_count: f64,
  pub dir_count: f64,
  pub children: Vec<DirectoryTreeNode>,
}

#[napi(object)]
pub struct DirectoryTreeResult {
  pub path: String,
  pub total_size: f64,
  pub file_count: f64,
  pub dir_count: f64,
  pub duration_ms: f64,
  pub workers: u32,
  pub tree: Vec<DirectoryTreeNode>,
}

#[derive(Default, Clone, Copy)]
struct Stats {
  size: u64,
  files: u64,
  dirs: u64,
}

impl Stats {
  fn add(&mut self, other: Stats) {
    self.size = self.size.saturating_add(other.size);
    self.files = self.files.saturating_add(other.files);
    self.dirs = self.dirs.saturating_add(other.dirs);
  }
}

fn napi_err(context: &str, err: impl std::fmt::Display) -> Error {
  Error::from_reason(format!("{context}: {err}"))
}

fn workers(value: Option<u32>) -> u32 {
  value
    .filter(|value| *value != 0)
    .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1))
    .min(1024)
}

fn display_path(path: &Path) -> String {
  path.to_string_lossy().into_owned()
}

fn cancelled(token: Option<&AtomicBool>) -> io::Result<()> {
  if token.is_some_and(|t| t.load(Ordering::Relaxed)) {
    Err(io::Error::new(io::ErrorKind::Interrupted, "job cancelled"))
  } else {
    Ok(())
  }
}

fn scan_path(path: &Path, token: Option<&AtomicBool>) -> io::Result<Stats> {
  let metadata = fs::symlink_metadata(path)?;
  if metadata.file_type().is_symlink() {
    return Ok(Stats::default());
  }
  if metadata.is_file() {
    return Ok(Stats { size: metadata.len(), files: 1, dirs: 0 });
  }
  if !metadata.is_dir() {
    return Ok(Stats::default());
  }

  let mut result = Stats { dirs: 1, ..Stats::default() };
  for entry in WalkDir::new(path).min_depth(1).follow_links(false) {
    cancelled(token)?;
    let entry = entry?;
    let ty = entry.file_type();
    if ty.is_symlink() {
      continue;
    }
    if ty.is_dir() {
      result.dirs = result.dirs.saturating_add(1);
    } else if ty.is_file() {
      let metadata = entry.metadata()?;
      result.files = result.files.saturating_add(1);
      result.size = result.size.saturating_add(metadata.len());
    }
  }
  Ok(result)
}

fn size_result(path: PathBuf, options: DirectorySizeOptions, token: Option<&AtomicBool>) -> Result<DirectorySizeResult> {
  let started = Instant::now();
  let stats = scan_path(&path, token).map_err(|e| napi_err("failed to calculate directory size", e))?;
  Ok(DirectorySizeResult {
    path: display_path(&path),
    total_size: stats.size as f64,
    file_count: stats.files as f64,
    dir_count: stats.dirs as f64,
    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    workers: workers(options.workers),
  })
}

fn glob_base(pattern: &Path) -> PathBuf {
  let mut base = PathBuf::new();
  for component in pattern.components() {
    let text = component.as_os_str().as_bytes();
    if text.iter().any(|b| matches!(b, b'*' | b'?' | b'[' | b'{')) {
      break;
    }
    base.push(component.as_os_str());
  }
  if base.as_os_str().is_empty() { PathBuf::from(".") } else { base }
}

fn glob_result(pattern: String, options: DirectorySizeOptions, token: Option<&AtomicBool>) -> Result<DirectorySizeResult> {
  let started = Instant::now();
  let matcher = Glob::new(&pattern)
    .map_err(|e| napi_err("invalid glob pattern", e))?
    .compile_matcher();
  let base = glob_base(Path::new(&pattern));
  let mut total = Stats::default();
  for entry in WalkDir::new(&base).follow_links(false) {
    cancelled(token).map_err(|e| napi_err("failed to calculate directory size", e))?;
    let entry = entry.map_err(|e| napi_err("failed to expand glob", e))?;
    if entry.file_type().is_symlink() || !matcher.is_match(entry.path()) {
      continue;
    }
    // Glob matches are counted themselves. Do not recursively count a matched
    // directory here, because its descendants are independently matched.
    if entry.file_type().is_dir() {
      total.dirs = total.dirs.saturating_add(1);
    } else if entry.file_type().is_file() {
      let metadata = entry.metadata().map_err(|e| napi_err("failed to read glob match", e))?;
      total.files = total.files.saturating_add(1);
      total.size = total.size.saturating_add(metadata.len());
    }
  }
  Ok(DirectorySizeResult {
    path: pattern,
    total_size: total.size as f64,
    file_count: total.files as f64,
    dir_count: total.dirs as f64,
    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    workers: workers(options.workers),
  })
}

fn build_tree(path: &Path, root: &Path, depth: u32, max_depth: u32, token: Option<&AtomicBool>) -> io::Result<(DirectoryTreeNode, Stats)> {
  cancelled(token)?;
  let mut stats = Stats { dirs: 1, ..Stats::default() };
  let mut children = Vec::new();
  for entry in fs::read_dir(path)? {
    cancelled(token)?;
    let entry = entry?;
    let metadata = fs::symlink_metadata(entry.path())?;
    if metadata.file_type().is_symlink() {
      continue;
    }
    if metadata.is_file() {
      stats.files = stats.files.saturating_add(1);
      stats.size = stats.size.saturating_add(metadata.len());
    } else if metadata.is_dir() {
      let child_depth = depth.saturating_add(1);
      if child_depth <= max_depth {
        let (node, child_stats) = build_tree(&entry.path(), root, child_depth, max_depth, token)?;
        stats.add(child_stats);
        children.push(node);
      } else {
        stats.add(scan_path(&entry.path(), token)?);
      }
    }
  }
  children.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
  let relative = path.strip_prefix(root).unwrap_or(path);
  let relative_path = if relative.as_os_str().is_empty() { ".".into() } else { display_path(relative) };
  Ok((DirectoryTreeNode {
    relative_path,
    depth,
    total_size: stats.size as f64,
    file_count: stats.files as f64,
    dir_count: stats.dirs as f64,
    children,
  }, stats))
}

fn tree_result(path: PathBuf, options: DirectoryTreeOptions, token: Option<&AtomicBool>) -> Result<DirectoryTreeResult> {
  let started = Instant::now();
  let max_depth = options.max_depth.unwrap_or(i32::MAX);
  if max_depth < 0 {
    return Err(Error::from_reason("max_depth must be >= 0"));
  }
  let metadata = fs::symlink_metadata(&path).map_err(|e| napi_err("failed to read root path", e))?;
  if !metadata.is_dir() || metadata.file_type().is_symlink() {
    return Err(Error::from_reason("path must be a directory"));
  }
  let (root_node, stats) = build_tree(&path, &path, 0, max_depth as u32, token)
    .map_err(|e| napi_err("failed to calculate directory tree", e))?;
  let tree = if options.include_root.unwrap_or(false) { vec![root_node] } else { root_node.children };
  Ok(DirectoryTreeResult {
    path: display_path(&path),
    total_size: stats.size as f64,
    file_count: stats.files as f64,
    dir_count: stats.dirs as f64,
    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    workers: workers(options.workers),
    tree,
  })
}

fn register_job(requested: Option<f64>) -> (u64, Arc<AtomicBool>) {
  let id = requested.filter(|v| v.is_finite() && *v >= 0.0).map(|v| v as u64)
    .unwrap_or_else(|| NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed));
  let token = Arc::new(AtomicBool::new(false));
  JOBS.lock().unwrap().insert(id, token.clone());
  (id, token)
}

fn finish_job(id: u64) {
  JOBS.lock().unwrap().remove(&id);
}

#[napi]
pub fn detect_hardlinks_sync(path1: String, path2: String) -> Result<bool> {
  let first = fs::symlink_metadata(&path1).map_err(|e| napi_err("failed to lstat first path", e))?;
  let second = fs::symlink_metadata(&path2).map_err(|e| napi_err("failed to lstat second path", e))?;
  Ok(!first.is_dir() && !second.is_dir() && first.dev() == second.dev() && first.ino() == second.ino())
}

#[napi]
pub async fn detect_hardlinks_async(path1: String, path2: String) -> Result<bool> {
  tokio::task::spawn_blocking(move || detect_hardlinks_sync(path1, path2)).await
    .map_err(|e| napi_err("hardlink worker failed", e))?
}

fn filesystem_name(path: &Path) -> Result<String> {
  let bytes = path.as_os_str().as_bytes();
  let c_path = std::ffi::CString::new(bytes).map_err(|_| Error::from_reason("path contains a NUL byte"))?;
  let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
  if unsafe { libc::statfs(c_path.as_ptr(), info.as_mut_ptr()) } != 0 {
    return Err(napi_err("statfs failed", io::Error::last_os_error()));
  }
  let magic = unsafe { info.assume_init() }.f_type as u64;
  let name = match magic {
    0xEF53 => "ext2/ext3/ext4", 0x9123_683E => "btrfs", 0x0102_1994 => "tmpfs",
    0x5846_5342 => "xfs", 0x4D44 | 0x4006 => "fat", 0x5346_544E => "ntfs",
    0x794C_7630 => "overlay", 0x6969 => "nfs", 0xFF53_4D42 => "cifs",
    0x9FA0 => "proc", 0x6265_6572 => "sysfs", 0x0102_1997 => "hugetlbfs",
    0x8584_58F6 => "ramfs", 0x2FC1_2FC1 => "zfs", 0x6573_5546 => "fuse",
    _ => return Ok(format!("unknown (0x{magic:x})")),
  };
  Ok(name.into())
}

#[napi]
pub fn detect_filesystem_sync(path: String) -> Result<String> { filesystem_name(Path::new(&path)) }

#[napi]
pub async fn detect_filesystem_async(path: String) -> Result<String> {
  tokio::task::spawn_blocking(move || detect_filesystem_sync(path)).await
    .map_err(|e| napi_err("filesystem worker failed", e))?
}

#[napi]
pub fn get_directory_size_sync(path: String, options: Option<DirectorySizeOptions>) -> Result<DirectorySizeResult> {
  size_result(PathBuf::from(path), options.unwrap_or_default(), None)
}

#[napi]
pub async fn get_directory_size_async(path: String, options: Option<DirectorySizeOptions>) -> Result<DirectorySizeResult> {
  let options = options.unwrap_or_default();
  let (id, token) = register_job(options.job_id);
  let result = tokio::task::spawn_blocking(move || size_result(PathBuf::from(path), options, Some(&token))).await
    .map_err(|e| napi_err("directory size worker failed", e))?;
  finish_job(id);
  result
}

#[napi]
pub fn get_directory_size_by_glob_sync(pattern: String, options: Option<DirectorySizeOptions>) -> Result<DirectorySizeResult> {
  glob_result(pattern, options.unwrap_or_default(), None)
}

#[napi]
pub async fn get_directory_size_by_glob_async(pattern: String, options: Option<DirectorySizeOptions>) -> Result<DirectorySizeResult> {
  let options = options.unwrap_or_default();
  let (id, token) = register_job(options.job_id);
  let result = tokio::task::spawn_blocking(move || glob_result(pattern, options, Some(&token))).await
    .map_err(|e| napi_err("glob worker failed", e))?;
  finish_job(id);
  result
}

#[napi]
pub fn get_directory_size_tree_sync(path: String, options: Option<DirectoryTreeOptions>) -> Result<DirectoryTreeResult> {
  tree_result(PathBuf::from(path), options.unwrap_or_default(), None)
}

#[napi]
pub async fn get_directory_size_tree_async(path: String, options: Option<DirectoryTreeOptions>) -> Result<DirectoryTreeResult> {
  let options = options.unwrap_or_default();
  let (id, token) = register_job(options.job_id);
  let result = tokio::task::spawn_blocking(move || tree_result(PathBuf::from(path), options, Some(&token))).await
    .map_err(|e| napi_err("directory tree worker failed", e))?;
  finish_job(id);
  result
}

#[napi]
pub fn cancel_job(job_id: f64) -> bool {
  if !job_id.is_finite() || job_id < 0.0 { return false; }
  JOBS.lock().unwrap().get(&(job_id as u64)).map(|token| {
    token.store(true, Ordering::Relaxed);
    true
  }).unwrap_or(false)
}

#[napi(js_name = "custom_gc")]
pub fn custom_gc() -> u32 { 0 }
