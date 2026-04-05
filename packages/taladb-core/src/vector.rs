//! Vector index support for TalaDB — Phase 1 (flat / brute-force search).
//!
//! Storage layout
//! ──────────────
//! Meta table  : `meta::vector_indexes`
//!   key       : `<collection>::<field>`   (UTF-8)
//!   value     : postcard-serialised `VectorDef`
//!
//! Vector table: `vec::<collection>::<field>`
//!   key       : ULID bytes (16 B, big-endian)
//!   value     : raw f32 LE bytes  (dimensions × 4 B)
//!
//! Search algorithm
//! ────────────────
//! Phase 1 uses a flat (brute-force) linear scan — O(n·d).
//! Every vector stored in the vec table is scored against the query vector,
//! results are sorted descending, and the top-k documents are loaded.
//! Phase 2 will replace this with an HNSW index for sub-linear search.

use serde::{Deserialize, Serialize};

use crate::document::{Document, Value};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const META_VECTOR_TABLE: &str = "meta::vector_indexes";

// ---------------------------------------------------------------------------
// VectorMetric
// ---------------------------------------------------------------------------

/// Similarity metric used when searching a vector index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub enum VectorMetric {
    /// Cosine similarity — angle between vectors, range [-1, 1].
    /// Best for text embeddings where magnitude is not meaningful.
    #[default]
    Cosine,
    /// Raw dot product — magnitude-sensitive.
    Dot,
    /// Euclidean distance converted to similarity via `1 / (1 + dist)`.
    /// Range (0, 1]; identical vectors score 1.0.
    Euclidean,
}

// ---------------------------------------------------------------------------
// VectorDef — index metadata persisted in redb
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorDef {
    pub collection: String,
    pub field: String,
    /// Expected dimensionality; enforced on insert and search.
    pub dimensions: usize,
    pub metric: VectorMetric,
}

// ---------------------------------------------------------------------------
// Table / key naming helpers
// ---------------------------------------------------------------------------

pub fn vec_meta_key(collection: &str, field: &str) -> String {
    format!("{}::{}", collection, field)
}

pub fn vec_table_name(collection: &str, field: &str) -> String {
    format!("vec::{}::{}", collection, field)
}

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

/// Encode a `&[f32]` as little-endian bytes.
pub fn encode_f32_vec(v: &[f32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(v.len() * 4);
    for f in v {
        buf.extend_from_slice(&f.to_le_bytes());
    }
    buf
}

/// Decode little-endian bytes back to `Vec<f32>`.
/// Returns `None` if `bytes.len()` is not a multiple of 4.
pub fn decode_f32_vec(bytes: &[u8]) -> Option<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// Extract a float vector from a document field value.
/// Accepts `Value::Array` whose elements are all numeric (`Float` or `Int`).
/// Returns `None` if the value is not a numeric array.
pub fn value_to_f32_vec(v: &Value) -> Option<Vec<f32>> {
    match v {
        Value::Array(arr) => arr
            .iter()
            .map(|item| match item {
                Value::Float(f) => Some(*f as f32),
                Value::Int(n) => Some(*n as f32),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Similarity functions
// ---------------------------------------------------------------------------

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
}

pub fn dot_similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Converts Euclidean distance to a similarity score in `(0, 1]`.
/// Identical vectors → 1.0; the further apart, the closer to 0.
pub fn euclidean_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dist: f32 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y).powi(2))
        .sum::<f32>()
        .sqrt();
    1.0 / (1.0 + dist)
}

pub fn compute_similarity(metric: &VectorMetric, a: &[f32], b: &[f32]) -> f32 {
    match metric {
        VectorMetric::Cosine => cosine_similarity(a, b),
        VectorMetric::Dot => dot_similarity(a, b),
        VectorMetric::Euclidean => euclidean_similarity(a, b),
    }
}

// ---------------------------------------------------------------------------
// Search result
// ---------------------------------------------------------------------------

/// A single result returned by `Collection::find_nearest`.
#[derive(Debug, Clone)]
pub struct VectorSearchResult {
    /// The matched document (all fields, including `_id`).
    pub document: Document,
    /// Similarity score — higher is more similar.
    /// Range depends on the metric: cosine ∈ [-1,1], dot ∈ ℝ, euclidean ∈ (0,1].
    pub score: f32,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let v = vec![0.1f32, -0.5, 1.0, 99.9];
        let decoded = decode_f32_vec(&encode_f32_vec(&v)).unwrap();
        for (a, b) in v.iter().zip(decoded.iter()) {
            assert!((a - b).abs() < 1e-6, "{a} != {b}");
        }
    }

    #[test]
    fn decode_rejects_odd_length() {
        assert!(decode_f32_vec(&[1, 2, 3]).is_none());
    }

    #[test]
    fn cosine_identical() {
        let a = vec![1.0f32, 2.0, 3.0];
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal() {
        let a = vec![1.0f32, 0.0];
        let b = vec![0.0f32, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn euclidean_identical() {
        let a = vec![1.0f32, 2.0, 3.0];
        assert!((euclidean_similarity(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn value_extraction_floats() {
        let v = Value::Array(vec![Value::Float(0.5), Value::Int(1), Value::Float(-0.25)]);
        let r = value_to_f32_vec(&v).unwrap();
        assert_eq!(r.len(), 3);
        assert!((r[0] - 0.5f32).abs() < 1e-6);
        assert_eq!(r[1], 1.0f32);
        assert!((r[2] - (-0.25f32)).abs() < 1e-6);
    }

    #[test]
    fn value_extraction_rejects_mixed() {
        let v = Value::Array(vec![Value::Float(0.5), Value::Str("x".into())]);
        assert!(value_to_f32_vec(&v).is_none());
    }

    #[test]
    fn value_extraction_rejects_non_array() {
        assert!(value_to_f32_vec(&Value::Str("vec".into())).is_none());
    }
}
