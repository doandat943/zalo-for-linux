use std::fmt;#[derive(Debug)]
pub struct KeyError;
impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("key must contain exactly 64 hex characters (32 bytes), with optional surrounding whitespace")
    }
}
impl std::error::Error for KeyError {}
pub fn parse(text: &str) -> Result<[u8; 32], KeyError> {
    let text = text.trim();
    if text.len() != 64 { return Err(KeyError); }
    let mut key = [0u8; 32];
    for (i, pair) in text.as_bytes().chunks_exact(2).enumerate() {
        let nibble =
            |b|
                match b {
                    b'0'..=b'9' => Ok(b - b'0'),
                    b'a'..=b'f' => Ok(b - b'a' + 10),
                    b'A'..=b'F' => Ok(b - b'A' + 10),
                    _ => Err(KeyError),
                };
        key[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Ok(key)
}
