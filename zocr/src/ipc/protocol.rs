use std::io::{self, Read, Write};
pub const VERSION: u16 = 1;
pub const PIPE_OPEN: u8 = 5;
pub const PATH_REQUEST: u8 = 1;
pub const PIPE_CLOSE: u8 = 6;
pub const OK: u8 = 0x80;
pub const PIPE_READY: u8 = 0x83;
pub const PIPE_ERR: u8 = 0x84;
pub const PIPE_EVENT: u8 = 0x85;
pub const ERR_DECODE: u8 = OK;
pub const ERR_INFER: u8 = OK;
pub const ERR_INTERNAL: u8 = OK;
pub const MAX_CONTROL: usize = 1024 * 1024;
pub const MAX_IMAGE: usize = 134217728;
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
pub struct Envelope {
    pub kind: u8,
    pub payload: Vec<u8>,
}
pub fn read_envelope(reader: &mut impl Read) -> io::Result<Option<Envelope>> {
    let mut length = [0u8; 4];
    if !first_byte(reader, &mut length[0])? { return Ok(None); }
    reader.read_exact(&mut length[1..])?;
    let len = u32::from_le_bytes(length) as usize;
    if !(3..=MAX_CONTROL).contains(&len) {
        return Err(invalid("control frame length must be 3 bytes to 1 MiB"));
    }
    let mut header = [0u8; 3];
    reader.read_exact(&mut header)?;
    if u16::from_le_bytes(header[..2].try_into().unwrap()) != VERSION {
        return Err(invalid("unsupported protocol version"));
    }
    let mut payload = vec![0; len - 3];
    reader.read_exact(&mut payload)?;
    Ok(Some(Envelope { kind: header[2], payload }))
}
fn first_byte(reader: &mut impl Read, byte: &mut u8) -> io::Result<bool> {
    loop {
        match reader.read(std::slice::from_mut(byte)) {
            Ok(0) => return Ok(false),
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}
pub fn write_reply(writer: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let len = payload.len().checked_add(3).filter(|&n| n <= MAX_CONTROL)
        .ok_or_else(|| invalid("response exceeds 1 MiB"))?;
    writer.write_all(&(len as u32).to_le_bytes())?;
    writer.write_all(&VERSION.to_le_bytes())?;
    writer.write_all(&[kind])?;
    writer.write_all(payload)?;
    writer.flush()
}
pub fn string_payload(text: &str) -> Vec<u8> {
    let mut out = (text.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(text.as_bytes());
    out
}
fn take_string<'a>(data: &mut &'a [u8]) -> io::Result<&'a str> {
    if data.len() < 4 { return Err(invalid("missing string length")); }
    let size = u32::from_le_bytes(data[..4].try_into().unwrap()) as usize;
    *data = &data[4..];
    if size > data.len() { return Err(invalid("truncated string")); }
    let text = std::str::from_utf8(&data[..size]).map_err(|_| invalid("invalid UTF-8"))?;
    *data = &data[size..];
    if text.contains('\0') { return Err(invalid("string contains NUL")); }
    Ok(text)
}
pub fn pipe_token(payload: &[u8]) -> io::Result<&str> {
    let mut data = payload;
    let token = take_string(&mut data)?;
    if token.is_empty() || token.len() > 65536 || !data.is_empty() {
        return Err(invalid("invalid pipe token"));
    }
    Ok(token)
}
pub fn image_path(payload: &[u8]) -> io::Result<&str> {
    let mut data = payload;
    let path = take_string(&mut data)?;
    let _format_hint = take_string(&mut data)?;
    if path.is_empty() || !data.is_empty() { return Err(invalid("invalid image path payload")); }
    Ok(path)
}
#[derive(Debug,PartialEq,Eq)]
pub struct RawHeader {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub size: usize,
    pub format: u32,
}
impl RawHeader {
    pub fn parse(bytes: &[u8; 27]) -> io::Result<Self> {
        if u16::from_le_bytes(bytes[..2].try_into().unwrap()) != VERSION {
            return Err(invalid("unsupported protocol version"));
        }
        if bytes[2] != 1 {
            return Err(invalid("unsupported raw frame type"));
        }
        let u32_at =
            |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        let width = u32_at(3);
        let height = u32_at(7);
        let stride = u32_at(11);
        let format = u32_at(23);
        let size = u64::from_le_bytes(bytes[15..23].try_into().unwrap());
        if !(1..=30000).contains(&width) || !(1..=30000).contains(&height) {
            return Err(invalid("raw dimensions must be in 1..=30000"));
        }
        if stride < width * 4 || stride % 4 != 0 {
            return Err(invalid("invalid raw image stride"));
        }
        if size != u64::from(stride) * u64::from(height) ||
                size > MAX_IMAGE as u64 {
            return Err(invalid("invalid raw image buffer size"));
        }
        if format != 1 && format != 2 {
            return Err(invalid("unsupported pixel format (expected RGBA or BGRA)"));
        }
        Ok(Self { width, height, stride, size: size as usize, format })
    }
}
