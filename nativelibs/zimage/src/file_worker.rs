use std::{fs, path::Path};

use napi::bindgen_prelude::*;

use crate::{
  image_utils::{output_format, process_image_bytes, validate_dimensions, OutputFormat},
  options::FileOptions,
};

pub struct FileThumbnailTask {
  input_path: String,
  output_path: String,
  width: u32,
  height: u32,
  format: OutputFormat,
}

impl FileThumbnailTask {
  pub fn new(options: FileOptions) -> Result<Self> {
    validate_dimensions(options.width, options.height)?;
    let format = output_format(
      Path::new(&options.output_path)
        .extension()
        .and_then(|extension| extension.to_str()),
    );
    Ok(Self {
      input_path: options.input_path,
      output_path: options.output_path,
      width: options.width,
      height: options.height,
      format,
    })
  }
}

impl Task for FileThumbnailTask {
  type Output = ();
  type JsValue = ();

  fn compute(&mut self) -> Result<Self::Output> {
    let input = fs::read(&self.input_path).map_err(|error| {
      Error::from_reason(format!("An error occurred in thumbnailing using file system: {error}"))
    })?;
    let output = process_image_bytes(&input, self.width, self.height, self.format)?;
    fs::write(&self.output_path, output).map_err(|error| {
      Error::from_reason(format!("An error occurred in thumbnailing using file system: {error}"))
    })?;
    Ok(())
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}
