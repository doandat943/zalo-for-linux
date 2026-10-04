use std::io::{self, Read, Write};
use subtle::ConstantTimeEq;
use super::protocol::VERSION;
pub fn verify_control(reader: &mut impl Read, expected: &[u8]) -> io::Result<bool> {
    let mut length = [0; 4];
    reader.read_exact(&mut length)?;
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > 65536 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid auth token length"));
    }
    let mut token = zeroize::Zeroizing::new(vec![0; size]);
    reader.read_exact(&mut token)?;
    Ok(bool::from(token.as_slice().ct_eq(expected)))
}
pub fn verify(stream: &mut (impl Read + Write), expected: &[u8])
    -> io::Result<bool> {
    let mut header = [0u8; 14];
    stream.read_exact(&mut header)?;
    let version = u16::from_le_bytes(header[8..10].try_into().unwrap());
    let len = u32::from_le_bytes(header[10..14].try_into().unwrap()) as usize;
    let valid_header =
        &header[..8] == b"ZOCRPIP1" && version == VERSION && len > 0 &&
            len <= 65536;
    let accepted =
        if valid_header {
            let mut token = zeroize::Zeroizing::new(vec![0u8;len]);
            stream.read_exact(&mut token)?;
            bool::from(token.as_slice().ct_eq(expected))
        } else { false };
    stream.write_all(&[1, 0, if accepted { 1 } else { 2 }, 0, 0, 0, 0])?;
    stream.flush()?;
    Ok(accepted)
}
