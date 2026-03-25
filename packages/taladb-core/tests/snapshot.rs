//! Integration tests for Database::export_snapshot / restore_from_snapshot
//! and Database::list_collection_names.

use taladb_core::{Database, Filter, Value};

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}

// ---------------------------------------------------------------------------
// list_collection_names
// ---------------------------------------------------------------------------

#[test]
fn list_collection_names_empty() {
    let db = Database::open_in_memory().unwrap();
    let names = db.list_collection_names().unwrap();
    assert!(names.is_empty(), "fresh db should have no collections");
}

#[test]
fn list_collection_names_after_insert() {
    let db = Database::open_in_memory().unwrap();

    db.collection("users").insert(vec![("name".into(), s("Alice"))]).unwrap();
    db.collection("posts").insert(vec![("title".into(), s("Hello"))]).unwrap();

    let mut names = db.list_collection_names().unwrap();
    names.sort();
    assert_eq!(names, ["posts", "users"]);
}

// ---------------------------------------------------------------------------
// export_snapshot / restore_from_snapshot
// ---------------------------------------------------------------------------

#[test]
fn snapshot_empty_database() {
    let db = Database::open_in_memory().unwrap();
    let bytes = db.export_snapshot().unwrap();
    // Must start with magic "TDBS"
    assert_eq!(&bytes[..4], b"TDBS");
    // Restore should succeed and produce an empty database
    let restored = Database::restore_from_snapshot(&bytes).unwrap();
    assert!(restored.list_collection_names().unwrap().is_empty());
}

#[test]
fn snapshot_round_trip_preserves_documents() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    let id1 = col.insert(vec![("x".into(), Value::Int(1))]).unwrap();
    let id2 = col.insert(vec![("x".into(), Value::Int(2))]).unwrap();

    // Export
    let bytes = db.export_snapshot().unwrap();

    // Restore
    let db2 = Database::restore_from_snapshot(&bytes).unwrap();
    let col2 = db2.collection("items");

    let docs = col2.find(Filter::All).unwrap();
    assert_eq!(docs.len(), 2);
    let ids: Vec<_> = docs.iter().map(|d| d.id).collect();
    assert!(ids.contains(&id1));
    assert!(ids.contains(&id2));
}

#[test]
fn snapshot_round_trip_preserves_multiple_collections() {
    let db = Database::open_in_memory().unwrap();
    db.collection("users").insert(vec![("name".into(), s("Alice"))]).unwrap();
    db.collection("posts").insert(vec![("title".into(), s("Hello"))]).unwrap();
    db.collection("posts").insert(vec![("title".into(), s("World"))]).unwrap();

    let bytes = db.export_snapshot().unwrap();
    let db2 = Database::restore_from_snapshot(&bytes).unwrap();

    let mut names = db2.list_collection_names().unwrap();
    names.sort();
    assert_eq!(names, ["posts", "users"]);
    assert_eq!(db2.collection("users").count(Filter::All).unwrap(), 1);
    assert_eq!(db2.collection("posts").count(Filter::All).unwrap(), 2);
}

#[test]
fn snapshot_round_trip_preserves_secondary_index() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");
    col.create_index("age").unwrap();
    col.insert(vec![("age".into(), Value::Int(30))]).unwrap();
    col.insert(vec![("age".into(), Value::Int(25))]).unwrap();

    let bytes = db.export_snapshot().unwrap();
    let db2 = Database::restore_from_snapshot(&bytes).unwrap();
    let col2 = db2.collection("users");

    // Index should be present and accelerate queries
    let found = col2.find(Filter::Eq("age".into(), Value::Int(30))).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].fields[0], ("age".to_string(), Value::Int(30)));
}

#[test]
fn restore_from_invalid_bytes_returns_error() {
    let result = Database::restore_from_snapshot(b"garbage data");
    assert!(result.is_err(), "corrupt snapshot must return an error");
}

#[test]
fn restore_from_empty_bytes_returns_error() {
    let result = Database::restore_from_snapshot(b"");
    assert!(result.is_err());
}
