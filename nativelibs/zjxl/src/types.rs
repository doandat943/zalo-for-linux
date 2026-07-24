use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct JxlInfo {
    pub width: u32,
    pub height: u32,
    pub orientation: u32,
}

#[napi(object)]
pub struct JxlToJpegOptions {
    pub buffer: Buffer,
    pub quality: Option<f64>,
    pub output_width: Option<i32>,
    pub output_height: Option<i32>,
    pub max_threads: Option<u32>,
    pub api_version: Option<i32>,
}

#[napi(object)]
pub struct BitmapToJxlOptions {
    pub buffer: Buffer,
    pub width: u32,
    pub height: u32,
    pub max_threads: Option<u32>,
    pub api_version: Option<i32>,
}

#[napi(object)]
pub struct ResizeJxlOptions {
    pub buffer: Buffer,
    pub width: u32,
    pub height: u32,
    pub max_threads: Option<u32>,
    pub api_version: Option<i32>,
}

#[napi(object)]
pub struct LocalPathOptions {
    pub local_path: String,
    pub quality: Option<f64>,
    pub max_width: Option<i32>,
    pub max_height: Option<i32>,
    pub output_path: Option<String>,
    pub chunk_size: Option<i32>,
    pub max_threads: Option<u32>,
    pub generate_preview: Option<bool>,
    pub preview_width: Option<i32>,
    pub preview_height: Option<i32>,
}

#[napi(object)]
pub struct DecompressTask {
    pub max_width: Option<i32>,
    pub max_height: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub output_path: Option<String>,
}

impl Default for DecompressTask {
    fn default() -> Self {
        Self { max_width: None, max_height: None, width: None, height: None, output_path: None }
    }
}

#[napi(object)]
pub struct DecompressMultiOptions {
    pub buffer: Option<Buffer>,
    pub local_path: Option<String>,
    pub quality: Option<f64>,
    pub tasks: Option<Vec<DecompressTask>>,
    pub chunk_size: Option<i32>,
    pub max_threads: Option<u32>,
    pub decode_local_one_shot_threshold: Option<u32>,
}

#[napi(object)]
pub struct DecompressMultiOutput {
    pub data: Buffer,
    pub size: u32,
    pub output_path: String,
    pub width: u32,
    pub height: u32,
}

#[napi(object)]
pub struct LocalPathOutput {
    pub data: Buffer,
    pub width: u32,
    pub height: u32,
    pub output_path: String,
    pub preview: Option<Buffer>,
}
