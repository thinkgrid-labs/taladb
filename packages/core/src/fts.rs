//! Full-text search index for TalaDB.
//!
//! Strategy: token-based inverted index stored in a redb table.
//!
//! Table name:  `fts::<collection>::<field>`
//! Key format:  `<token_bytes> ++ <ulid_bytes>` (16 B ULID suffix)
//! Value:       empty (the key itself is the record)
//!
//! On insert/update/delete, the set of tokens for the affected field is
//! computed and the corresponding index entries are added or removed.
//!
//! Query:  tokenize the search string, collect ULID sets per token, return
//!         the intersection (AND semantics, i.e. all tokens must appear).

use serde::{Deserialize, Serialize};
use ulid::Ulid;

// ---------------------------------------------------------------------------
// FTS index metadata (stored in `meta::fts_indexes`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtsDef {
    pub collection: String,
    pub field: String,
}

// ---------------------------------------------------------------------------
// Table naming
// ---------------------------------------------------------------------------

pub fn fts_table_name(collection: &str, field: &str) -> String {
    format!("fts::{}::{}", collection, field)
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/// Tokenize a string into lowercase, whitespace/punctuation-split tokens.
/// Tokens shorter than 2 characters are ignored.
pub fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2)
        .map(|t| t.to_lowercase())
        .collect()
}

// ---------------------------------------------------------------------------
// Key encoding
// ---------------------------------------------------------------------------

/// Encode a token + ULID into a sortable index key.
/// Format: `<token_utf8_bytes> ++ 0x00 ++ <ulid_16_bytes>`
/// The NUL separator lets us efficiently range-scan all ULIDs for a given token.
pub fn encode_fts_key(token: &str, ulid: &Ulid) -> Vec<u8> {
    let mut key = Vec::with_capacity(token.len() + 1 + 16);
    key.extend_from_slice(token.as_bytes());
    key.push(0x00); // separator
    key.extend_from_slice(&ulid.to_bytes());
    key
}

/// Build the inclusive key range for all ULIDs associated with `token`.
/// start = `<token> ++ 0x00 ++ [0x00 × 16]`
/// end   = `<token> ++ 0x00 ++ [0xFF × 16]`
pub fn fts_token_range(token: &str) -> (Vec<u8>, Vec<u8>) {
    let mut start = Vec::with_capacity(token.len() + 17);
    start.extend_from_slice(token.as_bytes());
    start.push(0x00);
    start.extend_from_slice(&[0x00u8; 16]);

    let mut end = Vec::with_capacity(token.len() + 17);
    end.extend_from_slice(token.as_bytes());
    end.push(0x00);
    end.extend_from_slice(&[0xFFu8; 16]);

    (start, end)
}

/// Extract the ULID from an FTS key (last 16 bytes).
pub fn ulid_from_fts_key(key: &[u8]) -> Option<Ulid> {
    if key.len() < 17 {
        return None;
    }
    let bytes: [u8; 16] = key[key.len() - 16..].try_into().ok()?;
    Some(Ulid::from_bytes(bytes))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_basic() {
        let tokens = tokenize("Hello, World! This is TalaDB.");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        assert!(tokens.contains(&"taladb".to_string()));
        // "is" has length 2 — kept
        assert!(tokens.contains(&"is".to_string()));
    }

    #[test]
    fn tokenize_strips_short() {
        let tokens = tokenize("a bb ccc");
        // "a" (len 1) dropped, "bb" kept, "ccc" kept
        assert!(!tokens.contains(&"a".to_string()));
        assert!(tokens.contains(&"bb".to_string()));
        assert!(tokens.contains(&"ccc".to_string()));
    }

    #[test]
    fn fts_key_round_trip() {
        let ulid = Ulid::new();
        let key = encode_fts_key("hello", &ulid);
        let decoded = ulid_from_fts_key(&key).unwrap();
        assert_eq!(decoded, ulid);
    }

    #[test]
    fn fts_token_range_bounds() {
        let (start, end) = fts_token_range("rust");
        assert!(start < end);
        // start must begin with "rust\0"
        assert_eq!(&start[..5], b"rust\0");
    }
}
