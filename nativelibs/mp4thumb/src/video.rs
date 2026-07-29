use std::{fs::File, path::Path, sync::{atomic::{AtomicBool, Ordering}, Arc}};

use image::{imageops::FilterType, RgbImage};
use mp4::{MediaType, Mp4Reader, TrackType};
use napi::{Error, Result, Status};
use openh264::{decoder::Decoder, formats::YUVSource};

const ANNEX_B_START_CODE: [u8; 4] = [0, 0, 0, 1];

pub fn generate_thumbnail(input_path: &str, output_path: &str, max_width: u32, max_height: u32, cancelled: &Arc<AtomicBool>) -> Result<bool> {
  if max_width == 0 || max_height == 0 {
    return Err(Error::new(Status::InvalidArg, "Thumbnail dimensions must be greater than zero"));
  }
  if is_cancelled(cancelled) { return Ok(false); }
  let file = File::open(input_path).map_err(|err| Error::new(Status::GenericFailure, format!("Cannot open video: {err}")))?;
  let size = file.metadata().map_err(|err| Error::new(Status::GenericFailure, format!("Cannot read video metadata: {err}")))?.len();
  let mut reader = Mp4Reader::read_header(file, size).map_err(|err| Error::new(Status::GenericFailure, format!("Cannot parse MP4 container: {err}")))?;
  let track_id = reader.tracks().iter().find_map(|(id, track)| {
    (matches!(track.track_type(), Ok(TrackType::Video)) && matches!(track.media_type(), Ok(MediaType::H264))).then_some(*id)
  }).ok_or_else(|| Error::new(Status::GenericFailure, "No H.264 video stream was found"))?;
  let sample_count = reader.tracks().get(&track_id).map(|track| track.sample_count())
    .ok_or_else(|| Error::new(Status::GenericFailure, "Video stream has no samples"))?;
  let mut decoder = Decoder::new().map_err(|err| Error::new(Status::GenericFailure, format!("Cannot initialize H.264 decoder: {err}")))?;

  for sample_id in 1..=sample_count {
    if is_cancelled(cancelled) { return Ok(false); }
    let Some(sample) = reader.read_sample(track_id, sample_id).map_err(|err| Error::new(Status::GenericFailure, format!("Cannot read video sample: {err}")))? else { continue; };
    let decoded = decoder.decode(&avcc_sample_to_annex_b(&sample.bytes)?)
      .map_err(|err| Error::new(Status::GenericFailure, format!("Cannot decode H.264 frame: {err}")))?;
    if is_cancelled(cancelled) { return Ok(false); }
    if let Some(frame) = decoded.into_iter().next() {
      let (source_width, source_height) = frame.dimensions();
      let (width, height) = scaled_dimensions(source_width as u32, source_height as u32, max_width, max_height)?;
      let mut rgb = vec![0; source_width * source_height * 3];
      frame.write_rgb8(&mut rgb);
      let source = RgbImage::from_raw(source_width as u32, source_height as u32, rgb)
        .ok_or_else(|| Error::new(Status::GenericFailure, "Decoder returned an invalid RGB frame"))?;
      let scaled = image::imageops::resize(&source, width, height, FilterType::Triangle);
      if is_cancelled(cancelled) { return Ok(false); }
      crate::image::write_jpeg(Path::new(output_path), scaled.as_raw(), width, height)?;
      return Ok(true);
    }
  }
  if is_cancelled(cancelled) { Ok(false) } else { Err(Error::new(Status::GenericFailure, "No decodable video frame was found")) }
}

fn is_cancelled(cancelled: &AtomicBool) -> bool { cancelled.load(Ordering::Acquire) }

fn scaled_dimensions(width: u32, height: u32, max_width: u32, max_height: u32) -> Result<(u32, u32)> {
  if width == 0 || height == 0 { return Err(Error::new(Status::GenericFailure, "Decoded video frame has invalid dimensions")); }
  let scale = (max_width as f64 / width as f64).min(max_height as f64 / height as f64).min(1.0);
  let scaled_width = ((width as f64 * scale).floor() as u32) & !1;
  let scaled_height = ((height as f64 * scale).floor() as u32) & !1;
  if scaled_width == 0 || scaled_height == 0 { return Err(Error::new(Status::InvalidArg, "Thumbnail dimensions are too small for this video")); }
  Ok((scaled_width, scaled_height))
}

fn avcc_sample_to_annex_b(sample: &[u8]) -> Result<Vec<u8>> {
  let mut output = Vec::with_capacity(sample.len() + 16);
  let mut remaining = sample;
  while !remaining.is_empty() {
    if remaining.len() < 4 { return Err(Error::new(Status::GenericFailure, "Invalid H.264 MP4 sample length")); }
    let nal_size = u32::from_be_bytes(remaining[..4].try_into().expect("slice length checked")) as usize;
    remaining = &remaining[4..];
    if nal_size == 0 || nal_size > remaining.len() { return Err(Error::new(Status::GenericFailure, "Invalid H.264 NAL unit length")); }
    output.extend_from_slice(&ANNEX_B_START_CODE);
    output.extend_from_slice(&remaining[..nal_size]);
    remaining = &remaining[nal_size..];
  }
  Ok(output)
}

#[cfg(test)]
mod tests {
  use super::{avcc_sample_to_annex_b, scaled_dimensions};
  #[test] fn converts_length_prefixed_nals() { assert_eq!(avcc_sample_to_annex_b(&[0, 0, 0, 2, 0x65, 1]).unwrap(), [0, 0, 0, 1, 0x65, 1]); }
  #[test] fn preserves_ratio_and_rounds_even() { assert_eq!(scaled_dimensions(1920, 1080, 640, 640).unwrap(), (640, 360)); }
}
