mod buffer_worker;
mod file_worker;
mod image_utils;
mod options;

use buffer_worker::BufferThumbnailTask;
use file_worker::FileThumbnailTask;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use options::{BufferOptions, FileOptions};
use std::thread;

/// Creates a thumbnail from an in-memory Node.js Buffer.
///
/// The callback follows Node's error-first convention and receives the encoded
/// image Buffer as its second argument on success.
#[napi]
pub fn thumbnail(options: BufferOptions, callback: JsFunction) -> Result<()> {
  let mut task = BufferThumbnailTask::new(options)?;
  let callback: ThreadsafeFunction<Buffer> =
    callback.create_threadsafe_function(0, |context| Ok(vec![context.value]))?;

  thread::spawn(move || {
    let result = task.compute().map(Buffer::from);
    let _ = callback.call(result, ThreadsafeFunctionCallMode::NonBlocking);
  });
  Ok(())
}

/// Creates a thumbnail from a file and writes it to `outputPath`.
///
/// JPEG is selected for `.jpg` and `.jpeg` output paths; all other paths use
/// PNG, matching this replacement's documented JPEG/PNG output surface.
#[napi(js_name = "thumbnailFs")]
pub fn thumbnail_fs(options: FileOptions, callback: JsFunction) -> Result<()> {
  let mut task = FileThumbnailTask::new(options)?;
  let callback: ThreadsafeFunction<Buffer> =
    callback.create_threadsafe_function(0, |context| Ok(vec![context.value]))?;

  thread::spawn(move || {
    let result = task.compute().map(|()| Buffer::from(Vec::new()));
    let _ = callback.call(result, ThreadsafeFunctionCallMode::NonBlocking);
  });
  Ok(())
}
