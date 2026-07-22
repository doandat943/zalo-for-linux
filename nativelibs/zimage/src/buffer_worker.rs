use napi::bindgen_prelude::*;

use crate::{
  image_utils::{output_format, process_image_bytes, validate_dimensions, OutputFormat},
  options::BufferOptions,
};

pub struct BufferThumbnailTask {
  input: Vec<u8>,
  width: u32,
  height: u32,
  format: OutputFormat,
}

impl BufferThumbnailTask {
  pub fn new(options: BufferOptions) -> Result<Self> {
    validate_dimensions(options.width, options.height)?;
    Ok(Self {
      input: options.buffer.to_vec(),
      width: options.width,
      height: options.height,
      format: output_format(options.format.as_deref()),
    })
  }
}

impl Task for BufferThumbnailTask {
  type Output = Vec<u8>;
  type JsValue = Buffer;

  fn compute(&mut self) -> Result<Self::Output> {
    process_image_bytes(&self.input, self.width, self.height, self.format)
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output.into())
  }
}
