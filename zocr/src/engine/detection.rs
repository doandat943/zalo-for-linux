use anyhow::{ensure, Result};
use clipper2_rust::{inflate_paths_64, EndType, JoinType, Point64};
use std::collections::VecDeque;
use super::geometry::{self, Point, Quad};
pub struct Detected {
    pub quad: Quad,
    pub score: f32,
}
pub fn postprocess(probability: &[f32], width: usize, height: usize,
    source_width: u32, source_height: u32) -> Result<Vec<Detected>> {
    ensure!(width>0 && height>0 &&
    width.checked_mul(height)==Some(probability.len()),"invalid detector probability map");
    let mut seen = vec![false;probability.len()];
    let mut found = Vec::new();
    let mut candidates = 0;
    for start in 0..probability.len() {
        if seen[start] || probability[start] < 0.3 { continue; }
        let mut queue = VecDeque::from([start]);
        seen[start] = true;
        let mut boundary = Vec::new();
        let mut sum = 0.;
        let mut count = 0;
        while let Some(p) = queue.pop_front() {
            let x = p % width;
            let y = p / width;
            sum += probability[p];
            count += 1;
            let mut edge =
                x == 0 || y == 0 || x + 1 == width || y + 1 == height;
            for ny in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                    let n = ny * width + nx;
                    if probability[n] < 0.3 {
                        edge = true;
                    } else if !seen[n] { seen[n] = true; queue.push_back(n); }
                }
            }
            if edge {
                boundary.extend([[x as f64, y as f64],
                            [(x + 1) as f64, y as f64],
                            [(x + 1) as f64, (y + 1) as f64],
                            [x as f64, (y + 1) as f64]]);
            }
        }
        if count < 3 { continue; }
        candidates += 1;
        if candidates > 1000 { break; }
        let hull = geometry::hull(boundary);
        let Some(initial) = geometry::min_quad(&hull) else { continue; };
        if geometry::distance(initial[0],
                        initial[1]).min(geometry::distance(initial[1], initial[2]))
                < 3. {
            continue;
        }
        let (area, perimeter) = geometry::area_perimeter(&hull);
        if perimeter <= 0. { continue; }
        let path: Vec<_> =
            hull.iter().map(|p|
                        Point64::new((p[0] * 1024.).round() as i64,
                            (p[1] * 1024.).round() as i64)).collect();
        let expanded =
            inflate_paths_64(&vec![path], area * 1.5 / perimeter * 1024.,
                JoinType::Round, EndType::Polygon, 2., 0.);
        // Reject splitting contours; a line must have a single expanded polygon.
        if expanded.len() != 1 { continue; }
        let polygon: Vec<Point> =
            expanded[0].iter().map(|p|
                        [p.x as f64 / 1024., p.y as f64 / 1024.]).collect();
        let Some(mut quad) =
            geometry::min_quad(&geometry::hull(polygon)) else { continue; };
        for p in &mut quad {
            p[0] =
                (p[0] * source_width as f64 /
                            width as
                                f64).clamp(0., source_width.saturating_sub(1) as f64);
            p[1] =
                (p[1] * source_height as f64 /
                            height as
                                f64).clamp(0., source_height.saturating_sub(1) as f64);
        }
        if geometry::distance(quad[0],
                        quad[1]).min(geometry::distance(quad[1], quad[2])) < 3. {
            continue;
        }
        found.push(Detected { quad, score: sum / count as f32 });
    }
    found.sort_by(|a, b|
            a.quad[0][1].total_cmp(&b.quad[0][1]).then(a.quad[0][0].total_cmp(&b.quad[0][0])));
    // Sort each group of nearly horizontal neighbors from left to right.
    let mut i = 0;
    while i < found.len() {
        let y = found[i].quad[0][1];
        let mut end = i + 1;
        while end < found.len() && (found[end].quad[0][1] - y).abs() < 10. {
            end += 1;
        }
        found[i..end].sort_by(|a, b| a.quad[0][0].total_cmp(&b.quad[0][0]));
        i = end;
    }
    Ok(found)
}
