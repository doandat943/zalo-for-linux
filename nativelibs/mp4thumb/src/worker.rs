use std::sync::{atomic::AtomicBool, Arc};

use napi::{bindgen_prelude::Task, Result};

pub struct GenerateThumbTask {
  pub input_path: String,
  pub output_path: String,
  pub max_width: u32,
  pub max_height: u32,
  pub cancelled: Arc<AtomicBool>,
}

impl Task for GenerateThumbTask {
  type Output = bool;
  type JsValue = bool;

  fn compute(&mut self) -> Result<Self::Output> {
    crate::video::generate_thumbnail(
      &self.input_path,
      &self.output_path,
      self.max_width,
      self.max_height,
      &self.cancelled,
    )
  }

  fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}
