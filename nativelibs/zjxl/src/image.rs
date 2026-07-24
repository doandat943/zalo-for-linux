use std::io::Cursor;

use fast_image_resize as fir;
use jxl_encoder::{LosslessConfig, PixelLayout};
use jxl_oxide::JxlImage;
use napi::bindgen_prelude::{Error, Result};

use crate::types::JxlInfo;

#[derive(Clone)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub data: Vec<u8>,
}

pub fn err(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}

pub fn decode(bytes: &[u8]) -> Result<Pixels> {
    let image = JxlImage::builder()
        .read(std::io::BufReader::new(Cursor::new(bytes)))
        .map_err(|e| err(format!("cannot decode JXL: {e}")))?;
    let frame = image.render_frame(0).map_err(|e| err(format!("cannot render JXL: {e}")))?;
    let mut stream = frame.stream();
    let (width, height, channels) = (stream.width(), stream.height(), stream.channels());
    if !(1..=4).contains(&channels) {
        return Err(err("unsupported JXL channel count"));
    }
    let mut data = vec![0; width as usize * height as usize * channels as usize];
    if stream.write_to_buffer(&mut data) != data.len() {
        return Err(err("incomplete pixel buffer rendered from JXL"));
    }
    Ok(Pixels { width, height, channels, data })
}

pub fn dimensions(bytes: &[u8]) -> Result<JxlInfo> {
    let image = JxlImage::builder()
        .read(std::io::BufReader::new(Cursor::new(bytes)))
        .map_err(|e| err(format!("cannot read JXL metadata: {e}")))?;
    Ok(JxlInfo {
        width: image.width(),
        height: image.height(),
        orientation: image.image_header().metadata.orientation,
    })
}

pub fn resize(mut pixels: Pixels, wanted_width: i32, wanted_height: i32) -> Result<Pixels> {
    let (width, height) = output_dimensions(pixels.width, pixels.height, wanted_width, wanted_height);
    if (width, height) == (pixels.width, pixels.height) {
        return Ok(pixels);
    }
    let pixel_type = match pixels.channels {
        1 => fir::PixelType::U8,
        2 => fir::PixelType::U8x2,
        3 => fir::PixelType::U8x3,
        4 => fir::PixelType::U8x4,
        _ => return Err(err("unsupported pixel layout")),
    };
    let source = fir::images::Image::from_vec_u8(pixels.width, pixels.height, pixels.data, pixel_type)
        .map_err(|e| err(format!("invalid source pixels: {e}")))?;
    let mut destination = fir::images::Image::new(width, height, pixel_type);
    fir::Resizer::new()
        .resize(&source, &mut destination, None)
        .map_err(|e| err(format!("resize failed: {e}")))?;
    pixels.width = width;
    pixels.height = height;
    pixels.data = destination.into_vec();
    Ok(pixels)
}

pub fn encode_jpeg(pixels: &Pixels, quality: f64) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let encoder = jpeg_encoder::Encoder::new(&mut output, (quality.clamp(0.0, 1.0) * 100.0).round() as u8);
    encoder
        .encode(&rgb_pixels(pixels), pixels.width as u16, pixels.height as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| err(format!("JPEG encode failed: {e}")))?;
    Ok(output)
}

pub fn encode_jxl(buffer: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let samples = (width as usize).checked_mul(height as usize).ok_or_else(|| err("image dimensions overflow"))?;
    let layout = match buffer.len() {
        n if n == samples * 3 => PixelLayout::Rgb8,
        n if n == samples * 4 => PixelLayout::Rgba8,
        _ => return Err(err("bitmap buffer must be exactly width*height*3 or width*height*4 bytes")),
    };
    LosslessConfig::new().encode(buffer, width, height, layout).map_err(|e| err(format!("JXL encode failed: {e}")))
}

fn output_dimensions(source_width: u32, source_height: u32, wanted_width: i32, wanted_height: i32) -> (u32, u32) {
    if wanted_width <= 0 && wanted_height <= 0 {
        return (source_width, source_height);
    }
    let ratio = source_width as f64 / source_height as f64;
    match (wanted_width > 0, wanted_height > 0) {
        (true, true) => (wanted_width as u32, wanted_height as u32),
        (true, false) => (wanted_width as u32, ((wanted_width as f64 / ratio).round() as u32).max(1)),
        (false, true) => (((wanted_height as f64 * ratio).round() as u32).max(1), wanted_height as u32),
        _ => unreachable!(),
    }
}

fn rgb_pixels(pixels: &Pixels) -> Vec<u8> {
    pixels
        .data
        .chunks_exact(pixels.channels as usize)
        .flat_map(|pixel| match pixels.channels {
            1 | 2 => [pixel[0], pixel[0], pixel[0]],
            _ => [pixel[0], pixel[1], pixel[2]],
        })
        .collect()
}
