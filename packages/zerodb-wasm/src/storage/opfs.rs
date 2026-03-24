/// OPFS (Origin Private File System) storage detection.
///
/// The actual OPFS-backed redb instance runs inside a dedicated SharedWorker
/// because `FileSystemSyncAccessHandle` requires a non-main thread.
/// This module provides:
///   1. A JS-callable function to check if OPFS is available.
///   2. Utilities to build the worker URL and pass messages.
///
/// The in-process in-memory backend is used when running unit tests
/// (wasm-bindgen-test) or when OPFS is unavailable.

use wasm_bindgen::prelude::*;

/// Returns true if OPFS is available in the current browser context.
/// Call this before attempting to open a file-backed database.
#[wasm_bindgen]
pub async fn is_opfs_available() -> bool {
    let window = web_sys::window();
    if window.is_none() {
        return false;
    }
    let navigator = window.unwrap().navigator();
    let storage = navigator.storage();

    // navigator.storage.getDirectory() resolves if OPFS is supported
    let promise = storage.get_directory();
    let result = wasm_bindgen_futures::JsFuture::from(promise).await;
    result.is_ok()
}
