use std::{fs::File, io::BufWriter, path::Path};

use image::{codecs::jpeg::JpegEncoder, ColorType, ImageEncoder};
use napi::{Error, Result, Status};

pub fn write_jpeg(path: &Path, rgb: &[u8], width: u32, height: u32) -> Result<()> {
  let file = File::create(path)
    .map_err(|err| Error::new(Status::GenericFailure, format!("Cannot create JPEG output: {err}")))?;
  let encoder = JpegEncoder::new_with_quality(BufWriter::new(file), 95);
  encoder.write_image(rgb, width, height, ColorType::Rgb8.into())
    .map_err(|err| Error::new(Status::GenericFailure, format!("Cannot encode JPEG: {err}")))
}
