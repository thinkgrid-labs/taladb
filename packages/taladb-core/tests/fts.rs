use taladb_core::document::Value;
use taladb_core::{Database, Filter};

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

// ---------------------------------------------------------------------------
// Index lifecycle
// ---------------------------------------------------------------------------

#[test]
fn create_and_drop_fts_index() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("articles");

    col.create_fts_index("body").unwrap();

    col.insert(vec![("body".into(), s("rust systems programming"))])
        .unwrap();
    let results = col
        .find(Filter::Contains("body".into(), "rust".into()))
        .unwrap();
    assert_eq!(results.len(), 1);

    col.drop_fts_index("body").unwrap();

    // After drop, Contains falls back to full-scan post-filter — still correct
    let results = col
        .find(Filter::Contains("body".into(), "rust".into()))
        .unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn create_fts_index_twice_returns_error() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("articles");
    col.create_fts_index("title").unwrap();
    let err = col.create_fts_index("title").unwrap_err();
    assert!(
        format!("{err}").contains("exists"),
        "expected IndexExists error, got: {err}"
    );
}

#[test]
fn drop_fts_index_nonexistent_returns_error() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("articles");
    let err = col.drop_fts_index("body").unwrap_err();
    assert!(
        format!("{err}").contains("not found"),
        "expected IndexNotFound error, got: {err}"
    );
}

// ---------------------------------------------------------------------------
// Single-token search
// ---------------------------------------------------------------------------

#[test]
fn fts_single_token_matches() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("posts");
    col.create_fts_index("content").unwrap();

    col.insert(vec![("content".into(), s("Hello world from TalaDB"))])
        .unwrap();
    col.insert(vec![("content".into(), s("Goodbye world"))])
        .unwrap();
    col.insert(vec![("content".into(), s("No match here"))])
        .unwrap();

    let results = col
        .find(Filter::Contains("content".into(), "taladb".into()))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0]
        .get("content")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("TalaDB"));
}

#[test]
fn fts_single_token_no_match_returns_empty() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("posts");
    col.create_fts_index("content").unwrap();

    col.insert(vec![("content".into(), s("Hello world"))])
        .unwrap();

    let results = col
        .find(Filter::Contains("content".into(), "rust".into()))
        .unwrap();
    assert!(results.is_empty());
}

// ---------------------------------------------------------------------------
// Multi-token AND semantics
// ---------------------------------------------------------------------------

#[test]
fn fts_multi_token_and_semantics() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs");
    col.create_fts_index("text").unwrap();

    col.insert(vec![("text".into(), s("rust and wasm are both great"))])
        .unwrap();
    col.insert(vec![("text".into(), s("rust is fast"))])
        .unwrap();
    col.insert(vec![("text".into(), s("wasm runs in browsers"))])
        .unwrap();

    // Both tokens must appear — only the first doc matches
    let results = col
        .find(Filter::Contains("text".into(), "rust wasm".into()))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0]
        .get("text")
        .unwrap()
        .as_str()
        .unwrap()
        .contains("rust"));
}

#[test]
fn fts_multi_token_partial_match_returns_empty() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs");
    col.create_fts_index("text").unwrap();

    col.insert(vec![("text".into(), s("only rust here"))])
        .unwrap();

    // "rust" matches but "wasm" doesn't — AND semantics, should be empty
    let results = col
        .find(Filter::Contains("text".into(), "rust wasm".into()))
        .unwrap();
    assert!(results.is_empty());
}

// ---------------------------------------------------------------------------
// Backfill: index created after documents exist
// ---------------------------------------------------------------------------

#[test]
fn fts_backfill_on_create_index() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("articles");

    // Insert before creating index
    col.insert(vec![("title".into(), s("Introduction to Rust"))])
        .unwrap();
    col.insert(vec![("title".into(), s("Getting started with WASM"))])
        .unwrap();

    col.create_fts_index("title").unwrap();

    let results = col
        .find(Filter::Contains("title".into(), "rust".into()))
        .unwrap();
    assert_eq!(
        results.len(),
        1,
        "backfilled index should find pre-existing docs"
    );
}

// ---------------------------------------------------------------------------
// Index maintained on updates
// ---------------------------------------------------------------------------

#[test]
fn fts_index_maintained_on_update() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("posts");
    col.create_fts_index("body").unwrap();

    col.insert(vec![("body".into(), s("old content about databases"))])
        .unwrap();

    // Update to remove old token and add new one
    col.update_one(
        Filter::Contains("body".into(), "databases".into()),
        taladb_core::Update::Set(vec![("body".into(), s("new content about rust"))]),
    )
    .unwrap();

    let old_results = col
        .find(Filter::Contains("body".into(), "databases".into()))
        .unwrap();
    let new_results = col
        .find(Filter::Contains("body".into(), "rust".into()))
        .unwrap();

    assert_eq!(
        old_results.len(),
        0,
        "old token should be removed from FTS index"
    );
    assert_eq!(new_results.len(), 1, "new token should be in FTS index");
}

// ---------------------------------------------------------------------------
// Index maintained on deletes
// ---------------------------------------------------------------------------

#[test]
fn fts_index_maintained_on_delete() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("posts");
    col.create_fts_index("body").unwrap();

    col.insert(vec![("body".into(), s("this is about rust"))])
        .unwrap();
    col.insert(vec![("body".into(), s("this is about wasm"))])
        .unwrap();

    col.delete_one(Filter::Contains("body".into(), "rust".into()))
        .unwrap();

    let results = col
        .find(Filter::Contains("body".into(), "rust".into()))
        .unwrap();
    assert_eq!(results.len(), 0, "deleted doc's FTS tokens must be removed");

    let wasm_results = col
        .find(Filter::Contains("body".into(), "wasm".into()))
        .unwrap();
    assert_eq!(
        wasm_results.len(),
        1,
        "non-deleted doc should still be found"
    );
}

// ---------------------------------------------------------------------------
// Case insensitive matching
// ---------------------------------------------------------------------------

#[test]
fn fts_case_insensitive() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");
    col.create_fts_index("name").unwrap();

    col.insert(vec![("name".into(), s("TalaDB is Awesome"))])
        .unwrap();

    // Query in different cases
    assert_eq!(
        col.find(Filter::Contains("name".into(), "taladb".into()))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        col.find(Filter::Contains("name".into(), "TALADB".into()))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        col.find(Filter::Contains("name".into(), "Awesome".into()))
            .unwrap()
            .len(),
        1
    );
}

// ---------------------------------------------------------------------------
// FTS on non-string field does not match
// ---------------------------------------------------------------------------

#[test]
fn fts_on_non_string_field_returns_empty() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");
    col.create_fts_index("count").unwrap();

    col.insert(vec![("count".into(), i(42))]).unwrap();

    let results = col
        .find(Filter::Contains("count".into(), "42".into()))
        .unwrap();
    assert_eq!(results.len(), 0, "FTS on non-string field should not match");
}

// ---------------------------------------------------------------------------
// FTS combined with snapshot round-trip
// ---------------------------------------------------------------------------

#[test]
fn fts_survives_snapshot_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("notes");
    col.create_fts_index("content").unwrap();

    col.insert(vec![("content".into(), s("snapshot test with rust"))])
        .unwrap();
    col.insert(vec![("content".into(), s("another note about wasm"))])
        .unwrap();

    let snapshot = db.export_snapshot().unwrap();
    let db2 = Database::restore_from_snapshot(&snapshot).unwrap();
    let col2 = db2.collection("notes");

    // FTS index tables are part of the snapshot — query should work
    let results = col2
        .find(Filter::Contains("content".into(), "rust".into()))
        .unwrap();
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// FTS across multiple collections are independent
// ---------------------------------------------------------------------------

#[test]
fn fts_indexes_are_collection_scoped() {
    let db = Database::open_in_memory().unwrap();

    let col_a = db.collection("colA");
    let col_b = db.collection("colB");

    col_a.create_fts_index("text").unwrap();
    col_b.create_fts_index("text").unwrap();

    col_a
        .insert(vec![("text".into(), s("rust programming"))])
        .unwrap();
    col_b
        .insert(vec![("text".into(), s("python scripting"))])
        .unwrap();

    let a_results = col_a
        .find(Filter::Contains("text".into(), "rust".into()))
        .unwrap();
    let b_results = col_b
        .find(Filter::Contains("text".into(), "rust".into()))
        .unwrap();

    assert_eq!(a_results.len(), 1);
    assert_eq!(
        b_results.len(),
        0,
        "colB should not see colA's index entries"
    );
}
