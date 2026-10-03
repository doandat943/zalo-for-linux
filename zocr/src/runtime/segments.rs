use std::fmt;

#[derive(Debug)]
pub struct SegmentError;
impl fmt::Display for SegmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("seg requires NCHW input with height 48, width divisible by 8 and valid per-image widths")
    }
}
impl std::error::Error for SegmentError {}

pub fn build(shape: &[i64], widths: &[u32]) -> Result<([i64; 2], Vec<i32>), SegmentError> {
    if shape.len() != 4 || !(1..=16).contains(&shape[0]) || shape[1] != 3
        || shape[2] != 48 || !(8..=4096).contains(&shape[3]) || shape[3] % 8 != 0
        || widths.len() != shape[0] as usize
        || widths.iter().any(|&w| w == 0 || w > shape[3] as u32)
    {
        return Err(SegmentError);
    }
    let steps = shape[3] as usize / 8;
    let mut data = vec![1; widths.len() * steps];
    for (i, &width) in widths.iter().enumerate() {
        // Equal(seg_i, seg_j) separates content from right-hand padding.
        let valid = width.div_ceil(8) as usize;
        data[i * steps..i * steps + valid].fill(0);
    }
    Ok(([shape[0], steps as i64], data))
}
