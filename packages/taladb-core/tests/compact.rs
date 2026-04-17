//! Integration tests for Database::compact() — WAL compaction.

use taladb_core::{Database, Filter, Update, Value};

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

#[test]
fn compact_empty_db_succeeds() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.compact().is_ok());
}

#[test]
fn compact_after_inserts_succeeds() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    for n in 0..50i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }
    assert!(db.compact().is_ok());
}

#[test]
fn compact_does_not_corrupt_existing_documents() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    let id1 = col.insert(vec![("val".into(), s("alpha"))]).unwrap();
    let id2 = col.insert(vec![("val".into(), s("beta"))]).unwrap();

    db.compact().unwrap();

    let docs = col.find(Filter::All).unwrap();
    assert_eq!(docs.len(), 2);
    let ids: Vec<_> = docs.iter().map(|d| d.id).collect();
    assert!(ids.contains(&id1));
    assert!(ids.contains(&id2));
}

#[test]
fn compact_after_bulk_delete_succeeds() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("tmp").unwrap();
    for n in 0..100i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }
    assert_eq!(col.delete_many(Filter::All).unwrap(), 100);

    db.compact().unwrap();

    assert_eq!(col.count(Filter::All).unwrap(), 0);
}

#[test]
fn compact_is_idempotent() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("data").unwrap();
    col.insert(vec![("x".into(), i(1))]).unwrap();

    db.compact().unwrap();
    db.compact().unwrap();

    assert_eq!(col.count(Filter::All).unwrap(), 1);
}

#[test]
fn compact_preserves_secondary_index() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users").unwrap();
    col.create_index("age").unwrap();
    col.insert(vec![("age".into(), i(30)), ("name".into(), s("Alice"))]).unwrap();
    col.insert(vec![("age".into(), i(25)), ("name".into(), s("Bob"))]).unwrap();

    db.compact().unwrap();

    let found = col.find(Filter::Eq("age".into(), i(30))).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].get("name"), Some(&s("Alice")));
}

#[test]
fn compact_preserves_documents_after_updates() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("counters").unwrap();
    col.insert(vec![("n".into(), i(0))]).unwrap();
    for _ in 0..10 {
        col.update_one(Filter::All, Update::Inc(vec![("n".into(), i(1))])).unwrap();
    }

    db.compact().unwrap();

    let docs = col.find(Filter::All).unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].get("n"), Some(&i(10)));
}

#[test]
fn compact_preserves_fts_index() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("articles").unwrap();
    col.create_fts_index("body").unwrap();
    col.insert(vec![("body".into(), s("hello world"))]).unwrap();
    col.insert(vec![("body".into(), s("goodbye world"))]).unwrap();

    db.compact().unwrap();

    let found = col.find(Filter::Contains("body".into(), "hello".into())).unwrap();
    assert_eq!(found.len(), 1);
}

#[test]
fn compact_preserves_multiple_collections() {
    let db = Database::open_in_memory().unwrap();
    db.collection("a").unwrap().insert(vec![("x".into(), i(1))]).unwrap();
    db.collection("b").unwrap().insert(vec![("x".into(), i(2))]).unwrap();
    db.collection("c").unwrap().insert(vec![("x".into(), i(3))]).unwrap();

    db.compact().unwrap();

    let mut names = db.list_collection_names().unwrap();
    names.sort();
    assert_eq!(names, ["a", "b", "c"]);
    assert_eq!(db.collection("b").unwrap().count(Filter::All).unwrap(), 1);
}

#[test]
fn snapshot_after_compact_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("notes").unwrap();
    col.insert(vec![("body".into(), s("keep me"))]).unwrap();

    db.compact().unwrap();

    let bytes = db.export_snapshot().unwrap();
    let db2 = Database::restore_from_snapshot(&bytes).unwrap();
    let docs = db2.collection("notes").unwrap().find(Filter::All).unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].get("body"), Some(&s("keep me")));
}
