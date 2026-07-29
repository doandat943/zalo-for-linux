mod image;
mod video;
mod worker;

use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};

use napi::{bindgen_prelude::AsyncTask, Error, Result, Status};
use napi_derive::napi;
use worker::GenerateThumbTask;

#[napi(js_name = "MP4Thumb")]
pub struct MP4Thumb {
  default_width: u32,
  default_height: u32,
  output_path: Mutex<String>,
  cancelled: Arc<AtomicBool>,
}

#[napi]
impl MP4Thumb {
  #[napi(constructor)]
  pub fn new(width: Option<u32>, height: Option<u32>) -> Self {
    Self {
      default_width: width.unwrap_or(640),
      default_height: height.unwrap_or(640),
      output_path: Mutex::new(String::new()),
      cancelled: Arc::new(AtomicBool::new(false)),
    }
  }

  #[napi(js_name = "setOutputPath")]
  pub fn set_output_path(&self, output_path: String) -> Result<()> {
    let mut stored = self.output_path.lock()
      .map_err(|_| Error::new(Status::GenericFailure, "MP4Thumb state lock is poisoned"))?;
    *stored = output_path;
    Ok(())
  }

  #[napi(js_name = "generateThumbnail")]
  pub fn generate_thumbnail(
    &self,
    input_path: String,
    output_path: String,
    width: Option<u32>,
    height: Option<u32>,
  ) -> Result<bool> {
    self.cancelled.store(false, Ordering::Release);
    video::generate_thumbnail(
      &input_path,
      &output_path,
      width.unwrap_or(self.default_width),
      height.unwrap_or(self.default_height),
      &self.cancelled,
    )
  }

  #[napi(js_name = "generateThumbnailAsync")]
  pub fn generate_thumbnail_async(
    &self,
    input_path: String,
    output_path: String,
    width: Option<u32>,
    height: Option<u32>,
  ) -> AsyncTask<GenerateThumbTask> {
    self.cancelled.store(false, Ordering::Release);
    AsyncTask::new(GenerateThumbTask {
      input_path,
      output_path,
      max_width: width.unwrap_or(self.default_width),
      max_height: height.unwrap_or(self.default_height),
      cancelled: Arc::clone(&self.cancelled),
    })
  }

  #[napi]
  pub fn cancel(&self) {
    self.cancelled.store(true, Ordering::Release);
  }
}
