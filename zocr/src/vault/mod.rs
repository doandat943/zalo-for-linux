pub mod container;
pub mod key;
use aes_gcm::{aead::{AeadInPlace, KeyInit}, Aes256Gcm, Nonce, Tag};
use anyhow::{Context, Result};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{fs, io::Read, path::Path};
use zeroize::Zeroizing;

pub struct Vault {
    bytes: Vec<u8>,
    index: container::Container,
    prk: Zeroizing<[u8; 32]>,
}
impl Vault {
    pub fn load(binary_dir: &Path) -> Result<Self> {
        let seed = read_key(binary_dir, "seed_key")?;
        let text_digest = read_key(binary_dir, "text_digest_key")?;
        let bytes = read_limited(&binary_dir.join("zocr/models.zmdl"), 268435456)
            .context("model vault not found: zocr/models.zmdl alongside binary")?;
        let index = container::Container::parse(&bytes)?;
        let prk = hmac_sha256(&index.salt, &[&*seed, &*text_digest]);
        Ok(Self { bytes, index, prk })
    }
    pub fn decrypt(&self, id: usize) -> Result<Zeroizing<Vec<u8>>> {
        let entry = self.index.entries.get(id).context("unknown model id")?;
        let key = hmac_sha256(&*self.prk, &[b"zocr-model-v1", &[id as u8, 1]]);
        let ciphertext = &self.bytes[entry.range.clone()];
        let split = ciphertext.len() - 16;
        let mut data = Zeroizing::new(ciphertext[..split].to_vec());
        let cipher = Aes256Gcm::new_from_slice(&*key)
            .map_err(|_| anyhow::anyhow!("invalid AES-256-GCM key length"))?;
        // Authenticate the complete header/index and the trailing 16-byte tag.
        let aad = &self.bytes[..24 + 29 * self.index.entries.len()];
        cipher.decrypt_in_place_detached(
            Nonce::from_slice(&entry.nonce), aad, &mut data,
            Tag::from_slice(&ciphertext[split..]),
        ).map_err(|_| anyhow::anyhow!("authentication verification failed for entry {id}"))?;
        Ok(data)
    }
}
fn read_key(binary_dir: &Path, filename: &str) -> Result<Zeroizing<[u8; 32]>> {
    let text = Zeroizing::new(read_limited(&binary_dir.join(filename), 4096)
        .with_context(|| format!("unable to read {filename} alongside binary"))?);
    let text = std::str::from_utf8(&text)
        .with_context(|| format!("{filename} must be UTF-8 hex text"))?;
    Ok(Zeroizing::new(key::parse(text).with_context(|| format!("invalid {filename}"))?))
}
fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> Zeroizing<[u8; 32]> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .expect("HMAC-SHA256 accepts keys of any length");
    for part in parts { mac.update(part); }
    Zeroizing::new(mac.finalize().into_bytes().into())
}

fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    anyhow::ensure!(file.metadata()?.len() <= limit as u64,
    "file exceeds size limit: {}", path.display());
    let mut data = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut data)?;
    anyhow::ensure!(data.len() <= limit, "file exceeds size limit: {}",
    path.display());
    Ok(data)
}
