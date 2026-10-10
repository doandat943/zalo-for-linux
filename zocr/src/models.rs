use anyhow::{ensure, Context, Result};
use std::{fs::File, io::Read, path::Path};

const FILES: [&str; 4] = ["detector.onnx", "recognizer.onnx", "classifier.onnx", "dictionary.txt"];
const MAX_SIZE: u64 = 268435456;

fn open(binary_dir: &Path, filename: &str) -> Result<File> {
    let path = binary_dir.join("models").join(filename);
    let file = File::open(&path)
        .with_context(|| format!("unable to read {} alongside binary", path.display()))?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file() && metadata.len() > 0 && metadata.len() <= MAX_SIZE,
        "model file must be nonempty and at most {MAX_SIZE} bytes: {}", path.display());
    Ok(file)
}

pub fn validate(binary_dir: &Path) -> Result<()> {
    for filename in FILES { open(binary_dir, filename)?; }
    Ok(())
}

pub fn read(binary_dir: &Path, filename: &str) -> Result<Vec<u8>> {
    let file = open(binary_dir, filename)?;
    let mut data = Vec::new();
    file.take(MAX_SIZE + 1).read_to_end(&mut data)?;
    ensure!(!data.is_empty() && data.len() as u64 <= MAX_SIZE,
        "model file is empty or exceeds size limit: models/{filename}");
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn reads_only_models_beside_binary_and_rejects_invalid_files() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("zocr-models-{}-{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()));
        fs::create_dir_all(dir.join("models"))?;
        let result = (|| -> Result<()> {
            assert!(validate(&dir).is_err());
            for filename in FILES { fs::write(dir.join("models").join(filename), b"model")?; }
            validate(&dir)?;
            assert_eq!(read(&dir, "recognizer.onnx")?, b"model");
            let path = dir.join("models/classifier.onnx");
            fs::write(&path, b"")?;
            assert!(validate(&dir).is_err());
            assert!(read(&dir, "classifier.onnx").is_err());
            File::create(&path)?.set_len(MAX_SIZE + 1)?;
            assert!(validate(&dir).is_err());
            assert!(read(&dir, "classifier.onnx").is_err());
            fs::remove_file(&path)?;
            fs::create_dir(&path)?;
            assert!(validate(&dir).is_err());
            Ok(())
        })();
        fs::remove_dir_all(dir)?;
        result
    }
}
