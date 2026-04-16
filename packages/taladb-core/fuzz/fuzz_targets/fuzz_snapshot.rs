#![no_main]
use libfuzzer_sys::fuzz_target;
use taladb_core::Database;

// Fuzz the snapshot restore path.
//
// Any input that causes a panic (beyond expected error returns) is a bug.
// The function should only ever return `Ok` or `Err(TalaDbError::InvalidSnapshot)`.
fuzz_target!(|data: &[u8]| {
    let _ = Database::restore_from_snapshot(data);
});
