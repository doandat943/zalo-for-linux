pub mod ctc;
pub mod geometry;
mod detection;
use anyhow::{ensure, Context, Result};
use image::{imageops, RgbImage};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Instant};
use crate::{
    config::Config, image as pixels, ipc::schema, platform::{self, Cpu},
    runtime::{Runtime, Session},
    vault::Vault,
};
struct Models {
    detector: Session,
    recognizer: Session,
    classifier: Session,
    dictionary: Vec<String>,
}
pub struct Engine {
    cfg: Config,
    cpu: Cpu,
    dir: PathBuf,
    runtime: Arc<Runtime>,
    models: Option<Models>,
    last_active: Instant,
}
impl Engine {
    pub fn new(dir: PathBuf, cfg: Config, cpu: Cpu) -> Result<Self> {
        let runtime = Runtime::load(&dir)?;
        // Validate key and container at startup; decrypted models load on demand.
        let _vault = Vault::load(&dir)?;
        Ok(Self {
                cfg,
                cpu,
                dir,
                runtime,
                models: None,
                last_active: Instant::now(),
            })
    }
    pub fn runtime(&self) -> Arc<Runtime> { self.runtime.clone() }
    fn load(&mut self) -> Result<f64> {
        if self.models.is_some() { return Ok(0.); }
        let start = Instant::now();
        let vault = Vault::load(&self.dir)?;
        let dictionary =
            {
                let bytes = vault.decrypt(2)?;
                let text =
                    std::str::from_utf8(&bytes).context("dictionary is not valid UTF-8 (check key/nonce convention)")?;
                let text = text.strip_prefix('\u{feff}').unwrap_or(text);
                let words: Vec<_> =
                    text.lines().map(|s|
                                s.trim_end_matches('\r').to_string()).collect();
                ensure!(!words.is_empty() && words.len()<100_000 &&
                words.iter().all(|s|!s.is_empty()),"invalid dictionary labels");
                words
            };
        let detector =
            {
                let plaintext = vault.decrypt(0)?;
                self.runtime.session(&plaintext, &self.cfg, "detector")?
            };
        let recognizer =
            {
                let plaintext = vault.decrypt(1)?;
                self.runtime.session(&plaintext, &self.cfg, "recognizer")?
            };
        let classifier =
            {
                let plaintext = vault.decrypt(3)?;
                self.runtime.session(&plaintext, &self.cfg, "classifier")?
            };
        self.models =
            Some(Models { detector, recognizer, classifier, dictionary });
        Ok(start.elapsed().as_secs_f64() * 1000.)
    }
    pub fn release_idle(&mut self) {
        if self.models.is_some() &&
                self.cfg.session_ttl.is_some_and(|ttl|
                        self.last_active.elapsed() >= ttl) {
            self.models = None;
            eprintln!("[zocr-host] idle: released OCR model sessions");
        }
    }
    pub fn recognize(&mut self, source: RgbImage) -> Result<Value> {
        let started = Instant::now();
        let before = platform::resources();
        let result = self.recognize_inner(source, before, started);
        self.last_active = Instant::now();
        result
    }
    fn recognize_inner(&mut self, source: RgbImage,
        before: platform::Resources, started: Instant) -> Result<Value> {
        ensure!(source.width()>0 && source.height()>0,"empty image");
        let init_ms = self.load()?;
        let models = self.models.as_mut().unwrap();
        let source_width = source.width();
        let source_height = source.height();
        let mut stages = json!({});
        let t = Instant::now();
        let capped = pixels::cap(&source, self.cfg.max_pixel_size);
        stages["capResizeMicros"] = json!(t.elapsed().as_micros());
        let det_started = Instant::now();
        let t = Instant::now();
        let expected = models.detector.input_shape();
        let aligned = pixels::detection(&capped);
        let width =
            if expected[3] > 0 {
                expected[3] as u32
            } else { aligned.width() };
        let height =
            if expected[2] > 0 {
                expected[2] as u32
            } else { aligned.height() };
        let resized =
            if aligned.width() == width && aligned.height() == height {
                aligned
            } else {
                imageops::resize(&capped, width, height,
                    imageops::FilterType::Triangle)
            };
        stages["detResizeMicros"] = json!(t.elapsed().as_micros());
        let t = Instant::now();
        let mut input = pixels::tensor(&resized, true);
        stages["detNormalizeMicros"] = json!(t.elapsed().as_micros());
        let t = Instant::now();
        let map =
            models.detector.run(&[1, 3, resized.height() as i64,
                                resized.width() as i64], &mut input)?;
        stages["detInferMicros"] = json!(t.elapsed().as_micros());
        ensure!(map.shape.len()==4 && map.shape[0]==1 && map.shape[1]==1 &&
        map.shape[2]>0 &&
        map.shape[3]>0,"detector expected [1,1,H,W] output");
        let t = Instant::now();
        let detected =
            detection::postprocess(&map.data, map.shape[3] as usize,
                    map.shape[2] as usize, source_width, source_height)?;
        stages["detPostprocessMicros"] = json!(t.elapsed().as_micros());
        let detection_ms = det_started.elapsed().as_secs_f64() * 1000.;
        let t = Instant::now();
        let cropped =
            detected.iter().map(|d|
                            pixels::crop(&source, d.quad)).collect::<Result<Vec<_>>>()?;
        let (mut crops, reading_quads): (Vec<_>, Vec<_>) =
            cropped.into_iter().unzip();
        stages["cropMicros"] = json!(t.elapsed().as_micros());
        let orientation_started = Instant::now();
        let mut flips = vec![false;crops.len()];
        if self.cfg.orientation && !crops.is_empty() {
            let probe = crops.len().min(self.cfg.orientation_probe);
            let expected = models.classifier.input_shape();
            ensure!(expected[0]<0 ||
            expected[0]==1,"classifier must support batch size 1");
            let width =
                if expected[3] > 0 { expected[3] as u32 } else { 160 };
            let height = if expected[2] > 0 { expected[2] as u32 } else { 80 };
            for i in 0..probe {
                let (shape, mut data, _) =
                    pixels::batch(std::slice::from_ref(&crops[i]), height, Some(width));
                let output = models.classifier.run(&shape, &mut data)?;
                ensure!(output.shape==[1,2] &&
                output.data.len()==2,"classifier expected [N,2] output");
                let row = &output.data;
                let sum = row[0] + row[1];
                let p =
                    if row.iter().all(|v| (0.0..=1.0).contains(v)) &&
                            (sum - 1.).abs() < 0.01 {
                        row[1]
                    } else { 1. / (1. + (row[0] - row[1]).exp()) };
                flips[i] = p >= self.cfg.orientation_threshold;
            }
            // Probing assumes uniform document orientation only when a strict majority agrees.
            if flips[..probe].iter().filter(|&&f| f).count() * 2 > probe {
                flips.fill(true);
            }
            for (image, &flip) in crops.iter_mut().zip(&flips) {
                if flip { *image = imageops::rotate180(image); }
            }
        }
        let orientation_ms =
            orientation_started.elapsed().as_secs_f64() * 1000.;
        stages["clsMicros"] =
            json!(orientation_started.elapsed().as_micros());
        stages["clsFlippedCount"] =
            json!(flips.iter().filter(|&&f|f).count());
        let rec_started = Instant::now();
        let mut order: Vec<_> = (0..crops.len()).collect();
        order.sort_by_key(|&i|
                crops[i].width() as u64 * 48 / crops[i].height() as u64);
        let mut decoded: Vec<Option<ctc::Decoded>> =
            (0..crops.len()).map(|_| None).collect();
        let mut pre_us = 0;
        let mut infer_us = 0;
        let mut decode_us = 0;
        let expected = models.recognizer.input_shape();
        let fixed_batch =
            if expected[0] > 0 { Some(expected[0] as usize) } else { None };
        let batch_size = fixed_batch.unwrap_or(8);
        ensure!(batch_size<=16,"recognizer fixed batch size exceeds 16");
        let fixed_width =
            if expected[3] > 0 { Some(expected[3] as u32) } else { None };
        for indices in order.chunks(batch_size) {
            let t = Instant::now();
            let mut images: Vec<_> =
                indices.iter().map(|&i| crops[i].clone()).collect();
            if let Some(n) = fixed_batch {
                while images.len() < n {
                    images.push(images.last().unwrap().clone());
                }
            }
            let (shape, mut data, widths) = pixels::batch(&images, 48, fixed_width);
            pre_us += t.elapsed().as_micros();
            let t = Instant::now();
            let output = models.recognizer.run_recognition(&shape, &mut data, &widths)?;
            infer_us += t.elapsed().as_micros();
            let t = Instant::now();
            let batch = images.len();
            if models.recognizer.has_segments() {
                ensure!(output.shape == [batch as i64, shape[3] / 8, (models.dictionary.len() + 1) as i64], "seg recognizer expected [N,W/8,dictionary+blank] output");
            }
            let items = ctc::decode_batch(&output.data, &output.shape, batch, &widths, shape[3] as u32, &models.dictionary)?;
            for (&index, item) in indices.iter().zip(items) {
                decoded[index] = Some(item);
            }
            decode_us += t.elapsed().as_micros();
        }
        stages["recPreprocessMicros"] = json!(pre_us);
        stages["recInferMicros"] = json!(infer_us);
        stages["recDecodeMicros"] = json!(decode_us);
        stages["recPipelineWallMicros"] =
            json!(rec_started.elapsed().as_micros());
        stages["recBatchCount"] = json!(order.len().div_ceil(batch_size));
        stages["recBatchItems"] = json!(order.len());
        let recognition_ms = rec_started.elapsed().as_secs_f64() * 1000.;
        let mut lines = Vec::new();
        for (i, (det, decoded)) in
            detected.into_iter().zip(decoded).enumerate() {
            let Some(decoded) = decoded else { continue; };
            if decoded.text.is_empty() ||
                    !ctc::keep_line(self.cfg.score_filter, det.score,
                            decoded.score, self.cfg.det_min, self.cfg.rec_min,
                            self.cfg.rec_keep) {
                continue;
            }
            // After a 180-degree crop rotation, the reading edges are reversed in source space.
            let q = reading_quads[i];
            let word_base =
                if flips[i] { [q[2], q[3], q[0], q[1]] } else { q };
            let words =
                ctc::words(&decoded).into_iter().map(|word|
                            schema::Word::from_decoded(word, word_base)).collect();
            lines.push(schema::Line {
                    text: decoded.text,
                    scores: schema::Scores {
                        detection: det.score,
                        recognition: decoded.score,
                    },
                    quad: det.quad.into(),
                    words,
                });
        }
        let mut meta =
            json!({"sourceWidth":source_width,"sourceHeight":source_height,"physicalCores":self.cpu.physical,"logicalCores":self.cpu.logical,"parallelBudget":self.cfg.parallel_budget,"runtimeInitMs":init_ms,"detectionMs":detection_ms,"orientationMs":orientation_ms,"recognitionMs":recognition_ms});
        if self.cfg.benchmark_profile { meta["stages"] = stages; }
        if self.cfg.benchmark_resources {
            let after = platform::resources();
            let wall = started.elapsed().as_micros().max(1) as f64;
            meta["resources"] =
                json!({"cpuCorePercent":after.cpu_micros.saturating_sub(before.cpu_micros)
                        as f64/wall*100.,"peakRssKiB":after.peak_rss_kib});
        }
        let angle =
            if !flips.is_empty() &&
                    flips.iter().filter(|&&f| f).count() * 2 > flips.len() {
                180
            } else { 0 };
        Ok(json!({"ok":true,"result":{"engineId":"zocr-onnx","textAngleDegrees":angle,"lines":lines,"meta":meta}}))
    }
}
