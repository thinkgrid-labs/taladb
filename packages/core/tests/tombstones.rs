//! Integration tests for Collection::compact_tombstones().

use taladb_core::sync::{now_ms, ChangeOp, LastWriteWins, SyncAdapter};
use taladb_core::{Database, Filter, Value};

fn i(n: i64) -> Value {
    Value::Int(n)
}

#[test]
fn compact_tombstones_returns_zero_when_no_tombstones() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    assert_eq!(col.compact_tombstones(u64::MAX).unwrap(), 0);
}

#[test]
fn compact_tombstones_returns_zero_on_empty_collection() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("ghost").unwrap();
    assert_eq!(col.compact_tombstones(u64::MAX).unwrap(), 0);
}

#[test]
fn compact_tombstones_removes_all_with_future_cutoff() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    for n in 0..5i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }
    col.delete_many(Filter::All).unwrap();

    let pruned = col.compact_tombstones(u64::MAX).unwrap();
    assert_eq!(pruned, 5);
}

#[test]
fn compact_tombstones_preserves_recent_tombstones() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    for n in 0..3i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }
    col.delete_many(Filter::All).unwrap();

    // cutoff 60 seconds in the past — tombstones just created must not be pruned
    let cutoff = now_ms().saturating_sub(60_000);
    let pruned = col.compact_tombstones(cutoff).unwrap();
    assert_eq!(pruned, 0);
}

#[test]
fn compact_tombstones_is_idempotent() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    col.insert(vec![("n".into(), i(1))]).unwrap();
    col.delete_one(Filter::All).unwrap();

    assert_eq!(col.compact_tombstones(u64::MAX).unwrap(), 1);
    assert_eq!(col.compact_tombstones(u64::MAX).unwrap(), 0); // already empty
}

#[test]
fn compact_tombstones_count_matches_deleted_docs() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    for n in 0..4i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }
    col.delete_many(Filter::All).unwrap();

    assert_eq!(col.compact_tombstones(u64::MAX).unwrap(), 4);
}

#[test]
fn compact_tombstones_does_not_affect_other_collections() {
    let db = Database::open_in_memory().unwrap();
    let col_a = db.collection("a").unwrap();
    let col_b = db.collection("b").unwrap();

    col_a.insert(vec![("n".into(), i(1))]).unwrap();
    col_a.delete_one(Filter::All).unwrap();

    col_b.insert(vec![("n".into(), i(2))]).unwrap();
    col_b.delete_one(Filter::All).unwrap();

    // Prune only collection "a"
    assert_eq!(col_a.compact_tombstones(u64::MAX).unwrap(), 1);

    // Collection "b" tombstone must still export
    let adapter_b = LastWriteWins::new();
    let changes = adapter_b.export_changes(&db, &["b"], 0).unwrap();
    let deletes: Vec<_> = changes
        .iter()
        .filter(|c| matches!(c.op, ChangeOp::Delete))
        .collect();
    assert_eq!(deletes.len(), 1);
}

#[test]
fn pruned_tombstones_do_not_appear_in_export_changes() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("events").unwrap();
    col.insert(vec![("n".into(), i(1))]).unwrap();
    col.delete_one(Filter::All).unwrap();

    col.compact_tombstones(u64::MAX).unwrap();

    let adapter = LastWriteWins::new();
    let changes = adapter.export_changes(&db, &["events"], 0).unwrap();
    let deletes: Vec<_> = changes
        .iter()
        .filter(|c| matches!(c.op, ChangeOp::Delete))
        .collect();
    assert!(deletes.is_empty());
}

#[test]
fn compact_tombstones_then_db_compact_succeeds() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("data").unwrap();
    for n in 0..20i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }
    col.delete_many(Filter::All).unwrap();

    assert_eq!(col.compact_tombstones(u64::MAX).unwrap(), 20);
    db.compact().unwrap();
    assert_eq!(col.count(Filter::All).unwrap(), 0);
}
