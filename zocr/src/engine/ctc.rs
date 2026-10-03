use std::fmt;#[derive(Debug, PartialEq)]
pub struct CtcError(pub &'static str);
impl fmt::Display for CtcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for CtcError {}
#[derive(Debug)]
pub struct Token {
    pub text: String,
    pub score: f32,
    pub start: usize,
    pub end: usize,
}
#[derive(Debug)]
pub struct Decoded {
    pub text: String,
    pub score: f32,
    pub tokens: Vec<Token>,
    pub steps: usize,
}
pub fn decode(data: &[f32], steps: usize, classes: usize,
    dictionary: &[String]) -> Result<Decoded, CtcError> {
    if classes != dictionary.len() + 1 ||
                steps.checked_mul(classes) != Some(data.len()) || steps == 0 {
        return Err(CtcError("CTC shape/dictionary mismatch"));
    }
    let mut tokens: Vec<Token> = Vec::new();
    let mut prev = 0;
    for (t, row) in data.chunks_exact(classes).enumerate() {
        if row.iter().any(|n| !n.is_finite()) {
            return Err(CtcError("non-finite CTC output"));
        }
        let class =
            row.iter().enumerate().max_by(|a, b|
                            a.1.total_cmp(b.1)).unwrap().0;
        let sum: f32 = row.iter().sum();
        let probability =
            if row.iter().all(|&v| (0.0..=1.0).contains(&v)) &&
                    (sum - 1.0).abs() < 0.01 {
                row[class]
            } else {
                let max = row[class];
                1.0 / row.iter().map(|x| (*x - max).exp()).sum::<f32>()
            };
        if class != 0 {
            if class != prev {
                tokens.push(Token {
                        // The model dictionary uses | as its word separator.
                        text: if dictionary[class - 1] == "|" { " ".into() } else { dictionary[class - 1].clone() },
                        score: probability,
                        start: t,
                        end: t + 1,
                    });
            } else if let Some(last) = tokens.last_mut() { last.end = t + 1; }
        }
        prev = class;
    }
    let text = tokens.iter().map(|t| t.text.as_str()).collect::<String>();
    let score =
        if tokens.is_empty() {
            0.0
        } else {
            tokens.iter().map(|t| t.score).sum::<f32>() / tokens.len() as f32
        };
    Ok(Decoded { text, score, tokens, steps })
}
pub fn decode_batch(data: &[f32], shape: &[i64], batch: usize, widths: &[u32], padded_width: u32, dictionary: &[String]) -> Result<Vec<Decoded>, CtcError> {
    let (steps, classes, time_first) = match shape {
        [n, t, c] if *n == batch as i64 && *t > 0 && *c > 0 => (*t as usize, *c as usize, false),
        [t, n, c] if *n == batch as i64 && *t > 0 && *c > 0 => (*t as usize, *c as usize, true),
        [t, c] if batch == 1 && *t > 0 && *c > 0 => (*t as usize, *c as usize, false),
        _ => return Err(CtcError("recognizer expected [N,T,C] or [T,N,C] output")),
    };
    if batch == 0 || widths.len() != batch || padded_width == 0
        || classes != dictionary.len() + 1
        || steps.checked_mul(batch).and_then(|n| n.checked_mul(classes)) != Some(data.len())
        || widths.iter().any(|&w| w == 0 || w > padded_width)
    {
        return Err(CtcError("recognizer shape/dictionary/width mismatch"));
    }
    let mut decoded = Vec::with_capacity(batch);
    for (item, &width) in widths.iter().enumerate() {
        // Discard padded timesteps before decoding and interpolating word boxes.
        let valid_steps = ((steps as u64 * width as u64).div_ceil(padded_width as u64) as usize).min(steps);
        let mut sequence = Vec::with_capacity(valid_steps * classes);
        for step in 0..valid_steps {
            let offset = if time_first { (step * batch + item) * classes } else { (item * steps + step) * classes };
            sequence.extend_from_slice(&data[offset..offset + classes]);
        }
        decoded.push(decode(&sequence, valid_steps, classes, dictionary)?);
    }
    Ok(decoded)
}

#[derive(Debug)]
pub struct Word {
    pub text: String,
    pub score: f32,
    pub start: f64,
    pub end: f64,
}
pub fn words(decoded: &Decoded) -> Vec<Word> {
    let mut words = Vec::new();
    let mut text = String::new();
    let mut scores = Vec::new();
    let mut start = 0;
    let mut end = 0;
    let flush =
        |words: &mut Vec<Word>, text: &mut String, scores: &mut Vec<f32>,
            start: usize, end: usize|
            {
                if !text.is_empty() {
                    words.push(Word {
                            text: std::mem::take(text),
                            score: scores.iter().sum::<f32>() / scores.len() as f32,
                            start: start as f64 / decoded.steps as f64,
                            end: end as f64 / decoded.steps as f64,
                        });
                    scores.clear();
                }
            };
    for (i, token) in decoded.tokens.iter().enumerate() {
        if text.is_empty() { start = token.start; }
        text.push_str(&token.text);
        scores.push(token.score);
        end = token.end;
        // Keep separators in words so concatenation preserves the complete line.
        if token.text.chars().all(char::is_whitespace)
            && decoded.tokens.get(i + 1).is_none_or(|next|
                !next.text.chars().all(char::is_whitespace)) {
            flush(&mut words, &mut text, &mut scores, start, end);
        }
    }
    flush(&mut words, &mut text, &mut scores, start, end);
    words
}
pub fn keep_line(enabled: bool, detection: f32, recognition: f32,
    det_min: f32, rec_min: f32, rec_keep: f32) -> bool {
    !enabled || recognition >= rec_keep ||
        (recognition >= rec_min && detection >= det_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_separator_becomes_space_in_text_and_words() {
        let dictionary = vec!["xin".into(), "|".into(), "chào!".into()];
        let data = [
            0., 1., 0., 0.,
            0., 0., 1., 0.,
            0., 0., 0., 1.,
        ];
        let decoded = decode(&data, 3, 4, &dictionary).unwrap();
        assert_eq!(decoded.text, "xin chào!");
        let words = words(&decoded);
        assert_eq!(words.iter().map(|word| word.text.as_str()).collect::<Vec<_>>(), ["xin ", "chào!"]);
        assert_eq!(words.iter().map(|word| word.text.as_str()).collect::<String>(), decoded.text);
    }
}
