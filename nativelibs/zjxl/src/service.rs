use std::fs;

use napi::bindgen_prelude::{Buffer, Result};

use crate::{
    image::{decode, dimensions, encode_jpeg, encode_jxl, err, resize},
    types::{
        BitmapToJxlOptions, DecompressMultiOptions, DecompressMultiOutput, DecompressTask,
        JxlInfo, JxlToJpegOptions, LocalPathOptions, LocalPathOutput, ResizeJxlOptions,
    },
};

pub fn get_info(buffer: &[u8]) -> Result<JxlInfo> {
    dimensions(buffer)
}

pub fn to_jpeg(options: JxlToJpegOptions) -> Result<Buffer> {
    let pixels = resize(
        decode(&options.buffer)?,
        options.output_width.unwrap_or(-1),
        options.output_height.unwrap_or(-1),
    )?;
    Ok(encode_jpeg(&pixels, options.quality.unwrap_or(0.95))?.into())
}

pub fn bitmap_to_jxl(options: BitmapToJxlOptions) -> Result<Buffer> {
    Ok(encode_jxl(&options.buffer, options.width, options.height)?.into())
}

pub fn resize_jxl(options: ResizeJxlOptions) -> Result<Buffer> {
    let pixels = resize(decode(&options.buffer)?, options.width as i32, options.height as i32)?;
    Ok(encode_jxl(&pixels.data, pixels.width, pixels.height)?.into())
}

pub fn to_jpeg_from_local_path(options: LocalPathOptions) -> Result<LocalPathOutput> {
    let data = fs::read(&options.local_path).map_err(|e| err(format!("cannot read localPath: {e}")))?;
    let pixels = resize(decode(&data)?, options.max_width.unwrap_or(-1), options.max_height.unwrap_or(-1))?;
    let quality = options.quality.unwrap_or(0.95);
    let jpeg = encode_jpeg(&pixels, quality)?;
    if let Some(path) = &options.output_path {
        fs::write(path, &jpeg).map_err(|e| err(format!("cannot write outputPath: {e}")))?;
    }
    let preview = if options.generate_preview.unwrap_or(false) {
        let preview_pixels = resize(
            pixels.clone(),
            options.preview_width.unwrap_or(1024),
            options.preview_height.unwrap_or(720),
        )?;
        Some(encode_jpeg(&preview_pixels, quality)?.into())
    } else {
        None
    };
    Ok(LocalPathOutput {
        data: jpeg.into(),
        width: pixels.width,
        height: pixels.height,
        output_path: options.output_path.unwrap_or_default(),
        preview,
    })
}

pub fn decompress_multi(options: DecompressMultiOptions) -> Result<Vec<DecompressMultiOutput>> {
    let source = match (options.buffer, options.local_path) {
        (Some(buffer), _) => buffer.to_vec(),
        (None, Some(path)) => fs::read(path).map_err(|e| err(format!("cannot read localPath: {e}")))?,
        (None, None) => return Err(err("buffer or localPath is required")),
    };
    let quality = options.quality.unwrap_or(0.95);
    let tasks = options.tasks.unwrap_or_else(|| vec![DecompressTask::default()]);
    tasks
        .into_iter()
        .map(|task| decompress_task(&source, task, quality))
        .collect()
}

fn decompress_task(source: &[u8], task: DecompressTask, quality: f64) -> Result<DecompressMultiOutput> {
    let pixels = resize(
        decode(source)?,
        task.width.or(task.max_width).unwrap_or(-1),
        task.height.or(task.max_height).unwrap_or(-1),
    )?;
    let jpeg = encode_jpeg(&pixels, quality)?;
    let output_path = task.output_path.unwrap_or_default();
    if !output_path.is_empty() {
        fs::write(&output_path, &jpeg).map_err(|e| err(format!("cannot write outputPath: {e}")))?;
    }
    Ok(DecompressMultiOutput {
        size: jpeg.len() as u32,
        data: jpeg.into(),
        output_path,
        width: pixels.width,
        height: pixels.height,
    })
}
