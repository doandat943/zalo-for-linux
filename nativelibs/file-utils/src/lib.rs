#![cfg(target_os = "linux")]

use napi_derive::napi;
use napi::{Error, Status, Result, JsUnknown, ValueType};
use std::ffi::CString;
use std::mem;

#[napi(object)]
pub struct DiskUsage {
  pub available: f64,
  pub free: f64,
  pub total: f64,
}

#[napi(ts_args_type = "path: string")]
pub fn get_disk_usage(path: Option<JsUnknown>) -> Result<DiskUsage> {
  let path_arg = match path {
    Some(p) => p,
    None => {
      return Err(Error::new(
        Status::InvalidArg,
        "DISKUSAGE_WRONG_NUMBER_OF_ARGS".to_string(),
      ));
    }
  };

  if path_arg.get_type()? != ValueType::String {
    return Err(Error::new(
      Status::InvalidArg,
      "DISKUSAGE_WRONG_NUMBER_OF_ARGS:  The \"path\" argument must be one of type string".to_string(),
    ));
  }

  let js_string = unsafe { path_arg.cast::<napi::JsString>() };
  let path_str = js_string.into_utf8()?.into_owned()?;

  let c_path = CString::new(path_str).map_err(|_| {
    Error::new(
      Status::InvalidArg,
      "DISKUSAGE_INVALID_ARG_TYPE: Path contains null byte".to_string(),
    )
  })?;

  let mut stat: libc::statvfs = unsafe { mem::zeroed() };
  let res = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };

  if res != 0 {
    return Err(Error::new(
      Status::GenericFailure,
      "DISKUSAGE_RUNTIME_ERROR: Get diskusage failed".to_string(),
    ));
  }

  let factor = if stat.f_frsize > 0 { stat.f_frsize } else { stat.f_bsize } as f64;

  let disk_info = DiskUsage {
    available: stat.f_bavail as f64 * factor,
    free: stat.f_bfree as f64 * factor,
    total: stat.f_blocks as f64 * factor,
  };

  Ok(disk_info)
}