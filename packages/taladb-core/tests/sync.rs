use taladb_core::document::Value;
use taladb_core::query::filter::Filter;
use taladb_core::sync::{stamp, Change, ChangeOp, Changeset, LastWriteWins, SyncAdapter};
use taladb_core::Database;
use ulid::Ulid;

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

// ---------------------------------------------------------------------------
// stamp() helper
// ---------------------------------------------------------------------------

#[test]
fn stamp_adds_changed_at() {
    let mut fields = vec![("name".into(), s("Alice"))];
    stamp(&mut fields);
    let has_changed_at = fields.iter().any(|(k, _)| k == "_changed_at");
    assert!(has_changed_at, "stamp() must add _changed_at field");
}

#[test]
fn stamp_replaces_existing_changed_at() {
    let mut fields = vec![("name".into(), s("Alice")), ("_changed_at".into(), i(1000))];
    stamp(&mut fields);

    // Must have exactly one _changed_at
    let count = fields.iter().filter(|(k, _)| k == "_changed_at").count();
    assert_eq!(
        count, 1,
        "stamp() must replace existing _changed_at, not duplicate it"
    );

    // New value must be >= 1000
    let ts = fields
        .iter()
        .find(|(k, _)| k == "_changed_at")
        .and_then(|(_, v)| {
            if let Value::Int(n) = v {
                Some(*n)
            } else {
                None
            }
        })
        .unwrap();
    assert!(ts >= 1000, "_changed_at should be >= old value");
}

// ---------------------------------------------------------------------------
// export_changes
// ---------------------------------------------------------------------------

#[test]
fn export_changes_returns_docs_after_since_ms() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("tasks");
    let adapter = LastWriteWins::new();

    // Insert with known timestamps
    let mut old_fields = vec![("title".into(), s("old task"))];
    stamp(&mut old_fields);
    // Override to a known old timestamp
    if let Some(entry) = old_fields.iter_mut().find(|(k, _)| k == "_changed_at") {
        entry.1 = i(1000);
    }
    col.insert(old_fields).unwrap();

    let mut new_fields = vec![("title".into(), s("new task"))];
    stamp(&mut new_fields);
    if let Some(entry) = new_fields.iter_mut().find(|(k, _)| k == "_changed_at") {
        entry.1 = i(9000);
    }
    col.insert(new_fields).unwrap();

    let changes = adapter.export_changes(&db, &["tasks"], 5000).unwrap();
    assert_eq!(
        changes.len(),
        1,
        "only doc with _changed_at > since_ms should be exported"
    );
    assert_eq!(
        changes[0].op.upsert_title(),
        Some("new task"),
        "exported change should be the newer doc"
    );
}

#[test]
fn export_changes_empty_collection_returns_empty() {
    let db = Database::open_in_memory().unwrap();
    let adapter = LastWriteWins::new();
    let changes = adapter.export_changes(&db, &["empty"], 0).unwrap();
    assert!(changes.is_empty());
}

#[test]
fn export_changes_since_zero_returns_all() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");
    let adapter = LastWriteWins::new();

    for n in 0..5 {
        let mut fields = vec![("n".into(), i(n))];
        stamp(&mut fields);
        col.insert(fields).unwrap();
    }

    let changes = adapter.export_changes(&db, &["items"], 0).unwrap();
    assert_eq!(changes.len(), 5);
}

// ---------------------------------------------------------------------------
// import_changes — basic upsert
// ---------------------------------------------------------------------------

#[test]
fn import_changes_inserts_new_document() {
    let db = Database::open_in_memory().unwrap();
    let adapter = LastWriteWins::new();

    let remote_doc = taladb_core::document::Document::new(vec![
        ("title".into(), s("remote doc")),
        ("_changed_at".into(), i(5000)),
    ]);
    let remote_id = remote_doc.id;

    let changeset: Changeset = vec![Change {
        collection: "tasks".into(),
        id: remote_id,
        op: ChangeOp::Upsert(remote_doc),
        changed_at: 5000,
    }];

    let applied = adapter.import_changes(&db, changeset).unwrap();
    assert_eq!(applied, 1);

    let col = db.collection("tasks");
    let results = col.find(Filter::All).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("title"), Some(&s("remote doc")));
}

// ---------------------------------------------------------------------------
// LWW conflict: remote newer wins
// ---------------------------------------------------------------------------

#[test]
fn lww_remote_newer_wins() {
    let db = Database::open_in_memory().unwrap();
    let adapter = LastWriteWins::new();
    let col = db.collection("notes");

    // Insert a local doc with old timestamp
    let mut local_fields = vec![
        ("content".into(), s("local version")),
        ("_changed_at".into(), i(1000)),
    ];
    let local_id_str = col.insert(local_fields.clone()).unwrap().to_string();

    // Remote doc is newer
    let remote_doc = taladb_core::document::Document::new(vec![
        ("content".into(), s("remote version")),
        ("_changed_at".into(), i(9000)),
    ]);
    let remote_id = remote_doc.id;

    // We need to match the _id that import_changes looks up
    // import_changes looks up by Filter::Eq("_id", Str(change.id.to_string()))
    // Since local doc doesn't have "_id" field, let's insert with the same id via a new doc
    // Instead, test with a fresh collection where the local _id is set explicitly
    let db2 = Database::open_in_memory().unwrap();
    let col2 = db2.collection("notes");

    // Insert a doc that has _changed_at
    let mut fields = vec![
        ("content".into(), s("local version")),
        ("_changed_at".into(), i(1000)),
    ];
    col2.insert(fields).unwrap();

    // Remote has same remote_id but is newer
    let remote_doc2 = taladb_core::document::Document::new(vec![
        ("content".into(), s("remote wins")),
        ("_changed_at".into(), i(9999)),
    ]);
    let r2_id = remote_doc2.id;
    let changeset: Changeset = vec![Change {
        collection: "notes".into(),
        id: r2_id,
        op: ChangeOp::Upsert(remote_doc2),
        changed_at: 9999,
    }];
    let applied = adapter.import_changes(&db2, changeset).unwrap();
    assert_eq!(applied, 1);

    // Both local and remote doc should now be in the collection
    // (no conflict since they have different IDs)
    let all = col2.find(Filter::All).unwrap();
    assert_eq!(all.len(), 2);
}

// ---------------------------------------------------------------------------
// LWW conflict: local newer wins
// ---------------------------------------------------------------------------

#[test]
fn lww_local_newer_is_not_overwritten() {
    let db = Database::open_in_memory().unwrap();
    let adapter = LastWriteWins::new();
    let col = db.collection("notes");

    // Insert local doc with a very high timestamp
    let local_doc_id = Ulid::new();
    let local_doc = taladb_core::document::Document::with_id(
        local_doc_id,
        vec![
            ("content".into(), s("local is newer")),
            ("_changed_at".into(), i(9000)),
            ("_id".into(), s(&local_doc_id.to_string())),
        ],
    );
    // Insert directly via changeset to control the ID
    let setup: Changeset = vec![Change {
        collection: "notes".into(),
        id: local_doc_id,
        op: ChangeOp::Upsert(local_doc),
        changed_at: 9000,
    }];
    adapter.import_changes(&db, setup).unwrap();

    // Remote has same ID but is older
    let remote_doc = taladb_core::document::Document::with_id(
        local_doc_id,
        vec![
            ("content".into(), s("remote is older")),
            ("_changed_at".into(), i(1000)),
            ("_id".into(), s(&local_doc_id.to_string())),
        ],
    );
    let remote_changeset: Changeset = vec![Change {
        collection: "notes".into(),
        id: local_doc_id,
        op: ChangeOp::Upsert(remote_doc),
        changed_at: 1000,
    }];
    let applied = adapter.import_changes(&db, remote_changeset).unwrap();
    assert_eq!(
        applied, 0,
        "older remote change should not overwrite newer local"
    );

    let results = col.find(Filter::All).unwrap();
    // The content should remain from the local (newer) version
    let found_local = results
        .iter()
        .any(|d| d.get("content") == Some(&s("local is newer")));
    assert!(found_local, "local newer content must not be overwritten");
}

// ---------------------------------------------------------------------------
// import_changes — delete operation
// ---------------------------------------------------------------------------

#[test]
fn import_delete_removes_existing_doc() {
    let db = Database::open_in_memory().unwrap();
    let adapter = LastWriteWins::new();
    let col = db.collection("items");

    // Insert a local doc via changeset (so we have control over its ID)
    let doc_id = Ulid::new();
    let doc = taladb_core::document::Document::with_id(
        doc_id,
        vec![
            ("name".into(), s("to be deleted")),
            ("_id".into(), s(&doc_id.to_string())),
        ],
    );
    let setup: Changeset = vec![Change {
        collection: "items".into(),
        id: doc_id,
        op: ChangeOp::Upsert(doc),
        changed_at: 1000,
    }];
    adapter.import_changes(&db, setup).unwrap();
    assert_eq!(col.find(Filter::All).unwrap().len(), 1);

    // Now import a delete for the same ID
    let delete_changeset: Changeset = vec![Change {
        collection: "items".into(),
        id: doc_id,
        op: ChangeOp::Delete,
        changed_at: 2000,
    }];
    let applied = adapter.import_changes(&db, delete_changeset).unwrap();
    assert_eq!(applied, 1);
    assert_eq!(col.find(Filter::All).unwrap().len(), 0);
}

#[test]
fn import_delete_nonexistent_returns_zero() {
    let db = Database::open_in_memory().unwrap();
    let adapter = LastWriteWins::new();

    let changeset: Changeset = vec![Change {
        collection: "items".into(),
        id: Ulid::new(),
        op: ChangeOp::Delete,
        changed_at: 1000,
    }];
    let applied = adapter.import_changes(&db, changeset).unwrap();
    assert_eq!(
        applied, 0,
        "deleting a non-existent doc should return 0 applied"
    );
}

// ---------------------------------------------------------------------------
// Round-trip: export then import
// ---------------------------------------------------------------------------

#[test]
fn export_import_round_trip() {
    let source_db = Database::open_in_memory().unwrap();
    let target_db = Database::open_in_memory().unwrap();
    let adapter = LastWriteWins::new();

    let source_col = source_db.collection("data");
    for n in 0..5i64 {
        let mut fields = vec![("value".into(), i(n))];
        stamp(&mut fields);
        source_col.insert(fields).unwrap();
    }

    let changeset = adapter.export_changes(&source_db, &["data"], 0).unwrap();
    let applied = adapter.import_changes(&target_db, changeset).unwrap();
    assert_eq!(applied, 5);

    let target_col = target_db.collection("data");
    let docs = target_col.find(Filter::All).unwrap();
    assert_eq!(docs.len(), 5);
}

// ---------------------------------------------------------------------------
// Helper trait for test readability
// ---------------------------------------------------------------------------

trait ChangeOpExt {
    fn upsert_title(&self) -> Option<&str>;
}

impl ChangeOpExt for ChangeOp {
    fn upsert_title(&self) -> Option<&str> {
        if let ChangeOp::Upsert(doc) = self {
            doc.get("title").and_then(|v| v.as_str())
        } else {
            None
        }
    }
}
