mod image;
mod service;
mod types;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use types::*;

#[napi(js_name = "moduleReady")]
pub fn module_ready() -> bool {
    true
}

#[napi(js_name = "getJxlInfo")]
pub fn get_jxl_info(buffer: Buffer) -> Result<JxlInfo> {
    service::get_info(&buffer)
}

#[napi(js_name = "jxlToJpeg")]
pub fn jxl_to_jpeg(options: JxlToJpegOptions) -> Result<Buffer> {
    service::to_jpeg(options)
}

#[napi(js_name = "bitmapToJxl")]
pub fn bitmap_to_jxl(options: BitmapToJxlOptions) -> Result<Buffer> {
    service::bitmap_to_jxl(options)
}

#[napi(js_name = "resizeJxl")]
pub fn resize_jxl(options: ResizeJxlOptions) -> Result<Buffer> {
    service::resize_jxl(options)
}

#[napi(js_name = "jxlToJpegFromLocalPath")]
pub fn jxl_to_jpeg_from_local_path(options: LocalPathOptions) -> Result<LocalPathOutput> {
    service::to_jpeg_from_local_path(options)
}

#[napi(js_name = "jxlDecompressMulti")]
pub fn jxl_decompress_multi(options: DecompressMultiOptions) -> Result<Vec<DecompressMultiOutput>> {
    service::decompress_multi(options)
}
