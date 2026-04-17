//! Integration tests for the append-only audit log.
//!
//! Covers: with_audit_log(), read_audit_log(), collection/op filters,
//! caller identity, no-op mutations, and snapshot round-trip.

use taladb_core::{read_audit_log, AuditOp, Database, Filter, Update, Value};

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

// ---------------------------------------------------------------------------
// Entry creation — one per mutation
// ---------------------------------------------------------------------------

#[test]
fn insert_writes_audit_entry() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("orders").unwrap().with_audit_log("svc:checkout".into());

    col.insert(vec![("amount".into(), i(42))]).unwrap();

    let entries = read_audit_log(db.backend(), None, None).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].collection, "orders");
    assert_eq!(entries[0].op, AuditOp::Insert);
    assert_eq!(entries[0].caller, "svc:checkout");
}

#[test]
fn insert_many_writes_one_entry_per_doc() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap().with_audit_log("svc:bulk".into());

    col.insert_many(vec![
        vec![("n".into(), i(1))],
        vec![("n".into(), i(2))],
        vec![("n".into(), i(3))],
    ])
    .unwrap();

    let entries = read_audit_log(db.backend(), None, None).unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries.iter().all(|e| e.op == AuditOp::Insert));
}

#[test]
fn update_one_writes_audit_entry() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("tasks").unwrap().with_audit_log("svc:api".into());

    col.insert(vec![("status".into(), s("pending"))]).unwrap();
    col.update_one(
        Filter::Eq("status".into(), s("pending")),
        Update::Set(vec![("status".into(), s("done"))]),
    )
    .unwrap();

    let updates = read_audit_log(db.backend(), None, Some(AuditOp::Update)).unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].collection, "tasks");
    assert_eq!(updates[0].caller, "svc:api");
}

#[test]
fn update_many_writes_one_entry_per_matched_doc() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("posts").unwrap().with_audit_log("svc:pub".into());

    col.insert(vec![("pub".into(), Value::Bool(false))]).unwrap();
    col.insert(vec![("pub".into(), Value::Bool(false))]).unwrap();
    col.insert(vec![("pub".into(), Value::Bool(true))]).unwrap();

    col.update_many(
        Filter::Eq("pub".into(), Value::Bool(false)),
        Update::Set(vec![("pub".into(), Value::Bool(true))]),
    )
    .unwrap();

    let updates = read_audit_log(db.backend(), None, Some(AuditOp::Update)).unwrap();
    assert_eq!(updates.len(), 2);
}

#[test]
fn delete_one_writes_audit_entry() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("sessions").unwrap().with_audit_log("svc:auth".into());

    col.insert(vec![("token".into(), s("abc"))]).unwrap();
    col.delete_one(Filter::Eq("token".into(), s("abc"))).unwrap();

    let deletes = read_audit_log(db.backend(), None, Some(AuditOp::Delete)).unwrap();
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0].caller, "svc:auth");
}

#[test]
fn delete_many_writes_one_entry_per_deleted_doc() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("logs").unwrap().with_audit_log("svc:gc".into());

    for n in 0..5i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }
    col.delete_many(Filter::All).unwrap();

    let deletes = read_audit_log(db.backend(), None, Some(AuditOp::Delete)).unwrap();
    assert_eq!(deletes.len(), 5);
}

// ---------------------------------------------------------------------------
// No-op mutations must not produce audit entries
// ---------------------------------------------------------------------------

#[test]
fn update_one_no_match_writes_no_audit_entry() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("things").unwrap().with_audit_log("svc".into());

    col.update_one(
        Filter::Eq("missing".into(), s("val")),
        Update::Set(vec![("missing".into(), s("new"))]),
    )
    .unwrap();

    let entries = read_audit_log(db.backend(), None, Some(AuditOp::Update)).unwrap();
    assert!(entries.is_empty());
}

#[test]
fn delete_one_no_match_writes_no_audit_entry() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("things").unwrap().with_audit_log("svc".into());

    col.delete_one(Filter::Eq("missing".into(), s("val"))).unwrap();

    let entries = read_audit_log(db.backend(), None, Some(AuditOp::Delete)).unwrap();
    assert!(entries.is_empty());
}

// ---------------------------------------------------------------------------
// Filters on read_audit_log
// ---------------------------------------------------------------------------

#[test]
fn filter_by_collection() {
    let db = Database::open_in_memory().unwrap();
    db.collection("orders").unwrap().with_audit_log("svc".into())
        .insert(vec![("x".into(), i(1))]).unwrap();
    db.collection("users").unwrap().with_audit_log("svc".into())
        .insert(vec![("x".into(), i(2))]).unwrap();

    let entries = read_audit_log(db.backend(), Some("orders"), None).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].collection, "orders");
}

#[test]
fn filter_by_op_insert() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("data").unwrap().with_audit_log("svc".into());
    col.insert(vec![("v".into(), i(1))]).unwrap();
    col.update_one(Filter::All, Update::Inc(vec![("v".into(), i(1))])).unwrap();

    let inserts = read_audit_log(db.backend(), None, Some(AuditOp::Insert)).unwrap();
    assert_eq!(inserts.len(), 1);
    assert_eq!(inserts[0].op, AuditOp::Insert);
}

#[test]
fn filter_by_op_delete() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("data").unwrap().with_audit_log("svc".into());
    col.insert(vec![("v".into(), i(1))]).unwrap();
    col.delete_one(Filter::All).unwrap();

    let deletes = read_audit_log(db.backend(), None, Some(AuditOp::Delete)).unwrap();
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0].op, AuditOp::Delete);
}

#[test]
fn filter_collection_and_op_combined() {
    let db = Database::open_in_memory().unwrap();
    let orders = db.collection("orders").unwrap().with_audit_log("svc".into());
    let users = db.collection("users").unwrap().with_audit_log("svc".into());

    orders.insert(vec![("x".into(), i(1))]).unwrap();
    users.insert(vec![("x".into(), i(2))]).unwrap();
    orders.update_one(Filter::All, Update::Inc(vec![("x".into(), i(1))])).unwrap();

    let entries = read_audit_log(db.backend(), Some("orders"), Some(AuditOp::Update)).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].collection, "orders");
    assert_eq!(entries[0].op, AuditOp::Update);
}

#[test]
fn filter_no_match_returns_empty() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap().with_audit_log("svc".into());
    col.insert(vec![("x".into(), i(1))]).unwrap();

    let entries = read_audit_log(db.backend(), Some("nonexistent"), None).unwrap();
    assert!(entries.is_empty());
}

// ---------------------------------------------------------------------------
// Ordering, doc_id, ts
// ---------------------------------------------------------------------------

#[test]
fn entries_are_in_insertion_order() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("seq").unwrap().with_audit_log("svc".into());

    let id1 = col.insert(vec![("n".into(), i(1))]).unwrap();
    let id2 = col.insert(vec![("n".into(), i(2))]).unwrap();
    let id3 = col.insert(vec![("n".into(), i(3))]).unwrap();

    let entries = read_audit_log(db.backend(), None, None).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].doc_id, id1.to_string());
    assert_eq!(entries[1].doc_id, id2.to_string());
    assert_eq!(entries[2].doc_id, id3.to_string());
}

#[test]
fn doc_id_matches_inserted_document_id() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("things").unwrap().with_audit_log("svc".into());
    let inserted_id = col.insert(vec![("x".into(), i(99))]).unwrap();

    let entries = read_audit_log(db.backend(), None, None).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].doc_id, inserted_id.to_string());
}

#[test]
fn ts_is_positive_unix_ms() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("t").unwrap().with_audit_log("svc".into());
    col.insert(vec![("x".into(), i(1))]).unwrap();

    let entries = read_audit_log(db.backend(), None, None).unwrap();
    assert!(entries[0].ts > 0);
}

// ---------------------------------------------------------------------------
// Unaudited collection produces no entries
// ---------------------------------------------------------------------------

#[test]
fn unaudited_collection_produces_no_entries() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("silent").unwrap(); // no with_audit_log()

    col.insert(vec![("x".into(), i(1))]).unwrap();
    col.update_one(Filter::All, Update::Inc(vec![("x".into(), i(1))])).unwrap();
    col.delete_one(Filter::All).unwrap();

    let entries = read_audit_log(db.backend(), None, None).unwrap();
    assert!(entries.is_empty());
}

// ---------------------------------------------------------------------------
// Snapshot round-trip
// ---------------------------------------------------------------------------

#[test]
fn audit_log_survives_snapshot_round_trip() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("things").unwrap().with_audit_log("svc:snap".into());
    col.insert(vec![("x".into(), i(1))]).unwrap();
    col.insert(vec![("x".into(), i(2))]).unwrap();

    let bytes = db.export_snapshot().unwrap();
    let db2 = Database::restore_from_snapshot(&bytes).unwrap();

    let entries = read_audit_log(db2.backend(), None, None).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| e.op == AuditOp::Insert));
    assert!(entries.iter().all(|e| e.caller == "svc:snap"));
}

// ---------------------------------------------------------------------------
// Multiple collections in same audit log
// ---------------------------------------------------------------------------

#[test]
fn audit_log_spans_multiple_collections() {
    let db = Database::open_in_memory().unwrap();
    db.collection("a").unwrap().with_audit_log("svc".into())
        .insert(vec![("x".into(), i(1))]).unwrap();
    db.collection("b").unwrap().with_audit_log("svc".into())
        .insert(vec![("x".into(), i(2))]).unwrap();
    db.collection("c").unwrap().with_audit_log("svc".into())
        .insert(vec![("x".into(), i(3))]).unwrap();

    let all = read_audit_log(db.backend(), None, None).unwrap();
    assert_eq!(all.len(), 3);

    let mut cols: Vec<_> = all.iter().map(|e| e.collection.as_str()).collect();
    cols.sort();
    assert_eq!(cols, ["a", "b", "c"]);
}
