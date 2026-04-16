#![no_main]
use libfuzzer_sys::fuzz_target;

// Fuzz the document filter/matching path by round-tripping arbitrary bytes
// through postcard deserialization and then applying a fixed filter.
//
// Catches panics in deserialization and filter evaluation on malformed data.
fuzz_target!(|data: &[u8]| {
    // Attempt to deserialize arbitrary bytes as a Document.
    // If deserialization succeeds, run a basic filter against it.
    if let Ok(doc) = postcard::from_bytes::<taladb_core::Document>(data) {
        use taladb_core::{Filter, Value};
        let _ = Filter::All.matches(&doc);
        let _ = Filter::Eq("_id".into(), Value::Str("x".into())).matches(&doc);
    }
});
