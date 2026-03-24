/// IndexedDB fallback storage for browsers without OPFS (Firefox).
///
/// Strategy: serialize the entire redb in-memory database to a single
/// Uint8Array, store it in IndexedDB under a fixed key, and reload it
/// on next open. Since redb's InMemoryBackend keeps data in RAM, we
/// flush to IDB at transaction commit boundaries.
///
/// This module exposes JS-callable async helpers for the flush/load cycle.
/// The wasm-bindgen surface in lib.rs orchestrates when to call them.

use wasm_bindgen::prelude::*;
use js_sys::{ArrayBuffer, Uint8Array};


/// Load a previous database snapshot from IndexedDB.
/// Returns None if no snapshot exists yet.
#[wasm_bindgen]
pub async fn idb_load_snapshot(db_name: &str) -> Option<Vec<u8>> {
    let key = format!("zerodb::{}", db_name);
    let window = web_sys::window()?;
    let storage: web_sys::Storage = window.local_storage().ok()??;
    let data = storage.get_item(&key).ok()??;

    // Base64-decode the stored snapshot
    let decoded = base64_decode(&data)?;
    Some(decoded)
}

/// Persist a database snapshot to IndexedDB (via localStorage for simplicity in v1).
/// In v2 this should use a proper IDBObjectStore for binary data.
#[wasm_bindgen]
pub async fn idb_save_snapshot(db_name: &str, data: &[u8]) -> bool {
    let key = format!("zerodb::{}", db_name);
    let window = match web_sys::window() {
        Some(w) => w,
        None => return false,
    };
    let storage: web_sys::Storage = match window.local_storage().ok().flatten() {
        Some(s) => s,
        None => return false,
    };
    let encoded = base64_encode(data);
    storage.set_item(&key, &encoded).is_ok()
}

fn base64_encode(data: &[u8]) -> String {
    // Simple base64 using js_sys
    let arr = Uint8Array::from(data);
    let buffer: ArrayBuffer = arr.buffer();
    // Use btoa via js_sys for simplicity
    let uint8 = Uint8Array::new(&buffer);
    let mut chars = Vec::with_capacity(data.len());
    for i in 0..uint8.length() {
        chars.push(uint8.get_index(i));
    }
    // Convert to base64 via String::from_utf8 trick
    // Real implementation would call js_sys::eval("btoa(...)") or use a crate
    base64_naive_encode(&chars)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    base64_naive_decode(s)
}

// Minimal base64 implementation (no external crate needed in WASM)
const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_naive_encode(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[b0 >> 2] as char);
        out.push(CHARS[((b0 & 0x3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3f] as char } else { '=' });
    }
    out
}

fn base64_naive_decode(s: &str) -> Option<Vec<u8>> {
    let s: Vec<u8> = s.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::new();
    for chunk in s.chunks(4) {
        let decode = |c: u8| -> Option<usize> {
            CHARS.iter().position(|&b| b == c)
        };
        let c0 = decode(chunk[0])?;
        let c1 = decode(chunk[1])?;
        out.push(((c0 << 2) | (c1 >> 4)) as u8);
        if chunk.len() > 2 {
            let c2 = decode(chunk[2])?;
            out.push(((c1 << 4) | (c2 >> 2)) as u8);
        }
        if chunk.len() > 3 {
            let c2 = decode(chunk[2])?;
            let c3 = decode(chunk[3])?;
            out.push(((c2 << 6) | c3) as u8);
        }
    }
    Some(out)
}
