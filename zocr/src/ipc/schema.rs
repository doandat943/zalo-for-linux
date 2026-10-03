use serde::Serialize;use crate::engine::{ctc, geometry};#[derive(Debug, Serialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
#[derive(Debug, Serialize)]
pub struct Quad {
    pub p1: Point,
    pub p2: Point,
    pub p3: Point,
    pub p4: Point,
}
impl From<geometry::Quad> for Quad {
    fn from(q: geometry::Quad) -> Self {
        let [p1, p2, p3, p4] =
            q.map(|p|
                    Point { x: p[0].round() as i32, y: p[1].round() as i32 });
        Self { p1, p2, p3, p4 }
    }
}
#[derive(Debug, Serialize)]
pub struct Word {
    pub text: String,
    pub quad: Quad,
    pub scores: WordScores,
}
#[derive(Debug, Serialize)]
pub struct WordScores {
    pub detection: Option<f32>,
    pub recognition: f32,
}
impl Word {
    pub fn from_decoded(word: ctc::Word, base: geometry::Quad) -> Self {
        Self {
            text: word.text,
            quad: geometry::word_quad(base, word.start, word.end).into(),
            scores: WordScores { detection: None, recognition: word.score },
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Scores {
    pub detection: f32,
    pub recognition: f32,
}
#[derive(Debug, Serialize)]
pub struct Line {
    pub text: String,
    pub scores: Scores,
    pub quad: Quad,
    pub words: Vec<Word>,
}
