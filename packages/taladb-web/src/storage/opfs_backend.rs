//! OPFS redb StorageBackend — uses `FileSystemSyncAccessHandle` for byte-level I/O.
//!
//! `FileSystemSyncAccessHandle` provides **synchronous** read/write/truncate/flush
//! operations and is only available in **dedicated** or **shared** worker threads.
//! It is the correct primitive for running redb on top of OPFS: no async, no
//! round-trips to the main thread, byte-addressable random I/O.
//!
//! Safety
//! ------
//! WASM is single-threaded. `FileSystemSyncAccessHandle` (a JS object) is not
//! `Send` by Rust's type system, but since there is exactly one thread in the
//! WASM runtime, the `unsafe impl Send + Sync` below is sound.

use std::io;

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::FileSystemSyncAccessHandle;

// ---------------------------------------------------------------------------
// OpfsBackend
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub struct OpfsBackend {
    handle: FileSystemSyncAccessHandle,
}

// FileSystemSyncAccessHandle is a JS object and doesn't implement Debug.
impl std::fmt::Debug for OpfsBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpfsBackend").finish_non_exhaustive()
    }
}

// WASM is single-threaded — this is safe.
unsafe impl Send for OpfsBackend {}
unsafe impl Sync for OpfsBackend {}

#[allow(dead_code)]
impl OpfsBackend {
    /// Wrap an existing `FileSystemSyncAccessHandle`.
    /// Call `OpfsBackend::open(db_name)` instead of constructing directly.
    pub fn from_handle(handle: FileSystemSyncAccessHandle) -> Self {
        OpfsBackend { handle }
    }

    // ------------------------------------------------------------------
    // Low-level helpers
    // ------------------------------------------------------------------

    fn js_read(&self, offset: u64, len: usize) -> Result<Vec<u8>, io::Error> {
        let buf = Uint8Array::new_with_length(len as u32);

        let opts = js_sys::Object::new();
        js_sys::Reflect::set(&opts, &"at".into(), &JsValue::from_f64(offset as f64))
            .map_err(|_| io_err("reflect set at"))?;

        // Use Reflect to call handle.read(buf, opts) — avoids depending on
        // specific web-sys method name overloads that change between versions.
        let handle_js: &JsValue = self.handle.as_ref();
        let read_fn: js_sys::Function = js_sys::Reflect::get(handle_js, &"read".into())
            .map_err(|_| io_err("opfs: get read fn"))?
            .dyn_into()
            .map_err(|_| io_err("opfs: read is not a function"))?;

        let result = read_fn
            .call2(handle_js, &buf, &opts)
            .map_err(|e| io_err(&format!("opfs read: {:?}", e)))?;

        let n = result
            .as_f64()
            .ok_or_else(|| io_err("opfs read: non-numeric return"))? as usize;
        let mut out = vec![0u8; n];
        buf.copy_to(&mut out[..n]);
        Ok(out)
    }

    fn js_write(&self, offset: u64, data: &[u8]) -> Result<(), io::Error> {
        let buf = Uint8Array::from(data);

        let opts = js_sys::Object::new();
        js_sys::Reflect::set(&opts, &"at".into(), &JsValue::from_f64(offset as f64))
            .map_err(|_| io_err("reflect set at"))?;

        // Use Reflect to call handle.write(buf, opts).
        let handle_js: &JsValue = self.handle.as_ref();
        let write_fn: js_sys::Function = js_sys::Reflect::get(handle_js, &"write".into())
            .map_err(|_| io_err("opfs: get write fn"))?
            .dyn_into()
            .map_err(|_| io_err("opfs: write is not a function"))?;

        write_fn
            .call2(handle_js, &buf, &opts)
            .map_err(|e| io_err(&format!("opfs write: {:?}", e)))?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// redb StorageBackend impl
// ---------------------------------------------------------------------------

impl redb::StorageBackend for OpfsBackend {
    fn len(&self) -> Result<u64, io::Error> {
        self.handle
            .get_size()
            .map(|s| s as u64)
            .map_err(|e| io_err(&format!("opfs get_size: {:?}", e)))
    }

    fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, io::Error> {
        self.js_read(offset, len)
    }

    fn set_len(&self, new_len: u64) -> Result<(), io::Error> {
        self.handle
            .truncate_with_f64(new_len as f64)
            .map_err(|e| io_err(&format!("opfs truncate: {:?}", e)))
    }

    fn sync_data(&self, _eventual: bool) -> Result<(), io::Error> {
        self.handle
            .flush()
            .map_err(|e| io_err(&format!("opfs flush: {:?}", e)))
    }

    fn write(&self, offset: u64, data: &[u8]) -> Result<(), io::Error> {
        self.js_write(offset, data)
    }
}

// ---------------------------------------------------------------------------
// Helper to open an OPFS file and return a SyncAccessHandle.
// Must be called from a Worker context.
// ---------------------------------------------------------------------------

/// Open (or create) an OPFS file and return an `OpfsBackend` for redb.
///
/// This function is **async** because `getFileHandle` and `createSyncAccessHandle`
/// are both async in the OPFS API. Call it once at worker startup.
#[wasm_bindgen]
pub async fn opfs_open_backend(db_name: &str) -> Result<JsValue, JsValue> {
    // Access the OPFS root from the worker global scope
    let global = js_sys::global();
    let navigator = js_sys::Reflect::get(&global, &"navigator".into())?;
    let storage = js_sys::Reflect::get(&navigator, &"storage".into())?;
    let get_dir: js_sys::Function =
        js_sys::Reflect::get(&storage, &"getDirectory".into())?.dyn_into()?;

    let dir: web_sys::FileSystemDirectoryHandle = wasm_bindgen_futures::JsFuture::from(
        get_dir.call0(&storage)?.dyn_into::<js_sys::Promise>()?,
    )
    .await?
    .dyn_into()?;

    // getFileHandle with create:true
    let file_opts = web_sys::FileSystemGetFileOptions::new();
    file_opts.set_create(true);

    let file_name = format!("taladb_{}.redb", db_name.replace(['/', '\\', ':'], "_"));

    let file_handle: web_sys::FileSystemFileHandle = wasm_bindgen_futures::JsFuture::from(
        dir.get_file_handle_with_options(&file_name, &file_opts),
    )
    .await?
    .dyn_into()?;

    // createSyncAccessHandle — only works in workers
    let create_sync: js_sys::Function =
        js_sys::Reflect::get(&file_handle, &"createSyncAccessHandle".into())?.dyn_into()?;

    let sync_handle: FileSystemSyncAccessHandle = wasm_bindgen_futures::JsFuture::from(
        create_sync
            .call0(&file_handle)?
            .dyn_into::<js_sys::Promise>()?,
    )
    .await?
    .dyn_into()?;

    // Return the raw JsValue so JS can pass it back into OpfsBackend::from_js_handle
    Ok(sync_handle.into())
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn io_err(msg: &str) -> io::Error {
    io::Error::other(msg)
}
