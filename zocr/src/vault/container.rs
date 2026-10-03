//! ZMDL v1: 24-byte header, four 29-byte entries.
use std::{fmt, ops::Range};
#[derive(Debug, PartialEq, Eq)]
pub struct VaultError(pub &'static str);
impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for VaultError {}
#[derive(Debug, Clone)]
pub struct Entry {
    pub range: Range<usize>,
    pub nonce: [u8; 12],
}
#[derive(Debug)]
pub struct Container {
    pub salt: [u8; 16],
    pub entries: [Entry; 4],
}
impl Container {
    pub fn parse(bytes: &[u8]) -> Result<Self, VaultError> {
        let err = |s| VaultError(s);
        if bytes.len() < 24 {
            return Err(err("model vault is smaller than its header"));
        }
        if &bytes[..4] != b"ZMDL" {
            return Err(err("model vault has an unexpected magic"));
        }
        if u16::from_le_bytes(bytes[4..6].try_into().unwrap()) != 1 {
            return Err(err("model vault version is not supported (expected 1)"));
        }
        if u16::from_le_bytes(bytes[6..8].try_into().unwrap()) != 4 {
            return Err(err("model vault must contain four entries"));
        }
        if bytes.len() < 140 {
            return Err(err("model vault entry table is truncated"));
        }
        let mut entries: [Option<Entry>; 4] = std::array::from_fn(|_| None);
        for i in 0..4 {
            let b = &bytes[24 + i * 29..24 + (i + 1) * 29];
            let id = b[0] as usize;
            if id >= 4 {
                return Err(err("model vault has an unknown entry type"));
            }
            if entries[id].is_some() {
                return Err(err("model vault has duplicate entries"));
            }
            let offset =
                usize::try_from(u64::from_le_bytes(b[13..21].try_into().unwrap())).map_err(|_|
                            err("model vault offset overflow"))?;
            let len =
                usize::try_from(u64::from_le_bytes(b[21..29].try_into().unwrap()))
                    .map_err(|_| err("model vault length overflow"))?;
            let end =
                offset.checked_add(len).ok_or_else(||
                            err("model vault length overflow"))?;
            if offset < 140 || len < 16 || end > bytes.len() {
                return Err(err("model vault entry is out of bounds"));
            }
            if entries.iter().flatten().any(|e|
                        offset < e.range.end && end > e.range.start) {
                return Err(err("model vault entries overlap"));
            }
            entries[id] =
                Some(Entry {
                        range: offset..end,
                        nonce: b[1..13].try_into().unwrap(),
                    });
        }
        Ok(Self {
                salt: bytes[8..24].try_into().unwrap(),
                entries: entries.map(Option::unwrap),
            })
    }
}
