use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct BufferOptions {
  pub buffer: Buffer,
  pub width: u32,
  pub height: u32,
  pub format: Option<String>,
}

#[napi(object)]
pub struct FileOptions {
  #[napi(js_name = "inputPath")]
  pub input_path: String,
  #[napi(js_name = "outputPath")]
  pub output_path: String,
  pub width: u32,
  pub height: u32,
}
