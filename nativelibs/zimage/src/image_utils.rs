use std::io::Cursor;

use image::{DynamicImage, ImageEncoder, RgbaImage, imageops::FilterType};
use napi::{Error, Result};

#[derive(Clone, Copy)]
pub enum OutputFormat {
  Jpeg,
  Png,
}

pub fn output_format(format: Option<&str>) -> OutputFormat {
  match format.map(str::to_ascii_lowercase).as_deref() {
    Some("jpeg") | Some("jpg") => OutputFormat::Jpeg,
    _ => OutputFormat::Png,
  }
}

pub fn validate_dimensions(width: u32, height: u32) -> Result<()> {
  if width == 0 || height == 0 {
    return Err(Error::from_reason("width and height must both be greater than zero"));
  }
  Ok(())
}

/// Blends an RGBA image onto white and returns an opaque RGB image.
pub fn flatten_alpha_to_white(image: RgbaImage) -> image::RgbImage {
  let (width, height) = image.dimensions();
  let mut output = image::RgbImage::new(width, height);

  for (x, y, pixel) in image.enumerate_pixels() {
    let alpha = u16::from(pixel[3]);
    let blend = |channel: u8| {
      ((u16::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8
    };
    output.put_pixel(x, y, image::Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]));
  }

  output
}

/// Decodes, resizes with Lanczos3, and encodes an image without copying input
/// metadata into the output.
pub fn process_image_bytes(
  input: &[u8],
  width: u32,
  height: u32,
  format: OutputFormat,
) -> Result<Vec<u8>> {
  validate_dimensions(width, height)?;
  let decoded = image::load_from_memory(input)
    .map_err(|error| Error::from_reason(format!("An error occurred in thumbnailing: {error}")))?;
  let resized = decoded.resize_exact(width, height, FilterType::Lanczos3);
  let mut encoded = Vec::new();

  match format {
    OutputFormat::Jpeg => {
      let rgb = flatten_alpha_to_white(resized.to_rgba8());
      image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 85)
        .write_image(
          rgb.as_raw(),
          width,
          height,
          image::ExtendedColorType::Rgb8,
        )
        .map_err(|error| Error::from_reason(format!("An error occurred in encoding: {error}")))?;
    }
    OutputFormat::Png => {
      let png = if resized.color().has_alpha() {
        DynamicImage::ImageRgba8(resized.to_rgba8())
      } else {
        DynamicImage::ImageRgb8(resized.to_rgb8())
      };
      png
        .write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
        .map_err(|error| Error::from_reason(format!("An error occurred in encoding: {error}")))?;
    }
  }

  Ok(encoded)
}
