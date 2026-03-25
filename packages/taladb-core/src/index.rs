//! Secondary index key encoding.
//!
//! Index keys are structured as:
//!   [type_prefix: 1 byte] [encoded_value: N bytes] [ulid: 16 bytes]
//!
//! The fixed-width 16-byte ULID suffix means there is no ambiguity in key
//! boundaries even for variable-length types like strings.
//!
//! Type prefixes ensure cross-type sort order:
//!   0x00 = Null
//!   0x10 = Bool(false)
//!   0x11 = Bool(true)
//!   0x20 = Int  (i64 big-endian, XOR 0x8000_0000_0000_0000 for correct signed sort)
//!   0x30 = Float (IEEE 754 bits, sign-magnitude encoded for sort correctness)
//!   0x40 = Str  (raw UTF-8 bytes; ULID suffix provides unambiguous boundary)
//!   0x50 = Bytes
//!   0x60 = Array / Object (not indexable — skipped silently)

use std::ops::Bound;

use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::document::Value;

/// Inclusive/exclusive byte-range bounds for an index scan.
pub type IndexBounds = Option<(Bound<Vec<u8>>, Bound<Vec<u8>>)>;

// ---------------------------------------------------------------------------
// Index key encoding
// ---------------------------------------------------------------------------

pub fn encode_index_key(value: &Value, id: Ulid) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    encode_value_prefix(value, &mut buf)?;
    buf.extend_from_slice(&id.to_bytes());
    Some(buf)
}

fn encode_value_prefix(value: &Value, buf: &mut Vec<u8>) -> Option<()> {
    match value {
        Value::Null => {
            buf.push(0x00);
        }
        Value::Bool(false) => {
            buf.push(0x10);
        }
        Value::Bool(true) => {
            buf.push(0x11);
        }
        Value::Int(n) => {
            buf.push(0x20);
            // XOR with sign bit to make two's-complement sort as unsigned big-endian
            let sortable = (*n as u64) ^ 0x8000_0000_0000_0000u64;
            buf.extend_from_slice(&sortable.to_be_bytes());
        }
        Value::Float(f) => {
            buf.push(0x30);
            let bits = f.to_bits();
            // IEEE 754 sort: if sign bit set, flip all bits; else flip just sign bit
            let sortable = if bits >> 63 == 1 { !bits } else { bits ^ 0x8000_0000_0000_0000 };
            buf.extend_from_slice(&sortable.to_be_bytes());
        }
        Value::Str(s) => {
            buf.push(0x40);
            buf.extend_from_slice(s.as_bytes());
        }
        Value::Bytes(b) => {
            buf.push(0x50);
            buf.extend_from_slice(b);
        }
        Value::Array(_) | Value::Object(_) => return None, // not indexable
    }
    Some(())
}

/// Build the range bounds for an index scan on an exact value.
/// Returns (start_inclusive, end_inclusive) byte ranges.
pub fn index_range_eq(value: &Value) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut start = Vec::new();
    encode_value_prefix(value, &mut start)?;
    let mut end = start.clone();
    // Append min/max ULID bytes to bracket the exact value
    start.extend_from_slice(&[0x00u8; 16]);
    end.extend_from_slice(&[0xFFu8; 16]);
    Some((start, end))
}

/// Build range bounds for gt/gte/lt/lte index scans.
pub fn index_range_cmp(
    lower: Option<(&Value, bool)>, // (value, inclusive)
    upper: Option<(&Value, bool)>,
) -> IndexBounds {
    let start = match lower {
        None => Bound::Unbounded,
        Some((v, inclusive)) => {
            let mut key = Vec::new();
            encode_value_prefix(v, &mut key)?;
            if inclusive {
                key.extend_from_slice(&[0x00u8; 16]);
                Bound::Included(key)
            } else {
                key.extend_from_slice(&[0xFFu8; 16]);
                Bound::Excluded(key)
            }
        }
    };

    let end = match upper {
        None => Bound::Unbounded,
        Some((v, inclusive)) => {
            let mut key = Vec::new();
            encode_value_prefix(v, &mut key)?;
            if inclusive {
                key.extend_from_slice(&[0xFFu8; 16]);
                Bound::Included(key)
            } else {
                key.extend_from_slice(&[0x00u8; 16]);
                Bound::Excluded(key)
            }
        }
    };

    Some((start, end))
}

/// Extract the ULID from an index key (last 16 bytes).
pub fn ulid_from_index_key(key: &[u8]) -> Option<Ulid> {
    if key.len() < 16 {
        return None;
    }
    let bytes: [u8; 16] = key[key.len() - 16..].try_into().ok()?;
    Some(Ulid::from_bytes(bytes))
}

// ---------------------------------------------------------------------------
// Index metadata
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexDef {
    pub collection: String,
    pub field: String,
}

pub fn meta_key(collection: &str, field: &str) -> String {
    format!("{}::{}", collection, field)
}

pub fn index_table_name(collection: &str, field: &str) -> String {
    format!("idx::{}::{}", collection, field)
}

pub fn docs_table_name(collection: &str) -> String {
    format!("docs::{}", collection)
}

pub const META_INDEXES_TABLE: &str = "meta::indexes";
pub const META_VERSION_TABLE: &str = "meta::db_version";
pub const META_VERSION_KEY: &[u8] = b"version";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int_sort_order() {
        let values = [Value::Int(-100), Value::Int(-1), Value::Int(0), Value::Int(1), Value::Int(100)];
        let id = Ulid::nil();
        let keys: Vec<Vec<u8>> = values.iter()
            .map(|v| encode_index_key(v, id).unwrap())
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "int index keys must sort in numeric order");
    }

    #[test]
    fn float_sort_order() {
        let values = [Value::Float(-1.0), Value::Float(0.0), Value::Float(0.5), Value::Float(1.0)];
        let id = Ulid::nil();
        let keys: Vec<Vec<u8>> = values.iter()
            .map(|v| encode_index_key(v, id).unwrap())
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "float index keys must sort in numeric order");
    }

    #[test]
    fn string_sort_order() {
        let values = [Value::Str("alpha".into()), Value::Str("beta".into()), Value::Str("gamma".into())];
        let id = Ulid::nil();
        let keys: Vec<Vec<u8>> = values.iter()
            .map(|v| encode_index_key(v, id).unwrap())
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "string index keys must sort lexicographically");
    }

    #[test]
    fn non_indexable_values_return_none() {
        let arr = Value::Array(vec![]);
        let obj = Value::Object(vec![]);
        assert!(encode_index_key(&arr, Ulid::nil()).is_none());
        assert!(encode_index_key(&obj, Ulid::nil()).is_none());
    }
}
