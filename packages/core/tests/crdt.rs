use taladb_core::crdt::{
    CrdtAdapter, CrdtChange, CrdtChangeset, CrdtSyncAdapter, FieldClock, FieldMutation,
    CRDT_CLOCKS_FIELD,
};
use taladb_core::document::{Document, Value};
use taladb_core::query::filter::Filter;
use taladb_core::Database;
use ulid::Ulid;

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

// ---------------------------------------------------------------------------
// stamp_insert
// ---------------------------------------------------------------------------

#[test]
fn stamp_insert_adds_clocks_and_changed_at() {
    let adapter = CrdtSyncAdapter::new("node-a");
    let fields = adapter.stamp_insert(vec![("title".into(), s("hello")), ("count".into(), i(1))]);

    let clocks = fields
        .iter()
        .find(|(k, _)| k == CRDT_CLOCKS_FIELD)
        .map(|(_, v)| v)
        .expect("_crdt_clocks must be present");
    let changed_at = fields
        .iter()
        .find(|(k, _)| k == "_changed_at")
        .map(|(_, v)| v)
        .expect("_changed_at must be present");

    if let Value::Object(entries) = clocks {
        assert!(entries.iter().any(|(k, _)| k == "title"));
        assert!(entries.iter().any(|(k, _)| k == "count"));
        // System fields must not get clocks.
        assert!(!entries.iter().any(|(k, _)| k.starts_with('_')));
    } else {
        panic!("_crdt_clocks must be an Object");
    }

    if let Value::Int(ts) = changed_at {
        assert!(*ts > 0, "_changed_at must be a positive timestamp");
    } else {
        panic!("_changed_at must be an Int");
    }
}

#[test]
fn stamp_insert_at_uses_supplied_timestamp() {
    let adapter = CrdtSyncAdapter::new("node-a");
    let fields = adapter.stamp_insert_at(vec![("x".into(), i(42))], 9999);

    let changed_at = fields
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
    assert_eq!(changed_at, 9999);
}

#[test]
fn stamp_insert_strips_existing_clock_field() {
    let adapter = CrdtSyncAdapter::new("node-a");
    let fields = adapter.stamp_insert(vec![
        ("x".into(), i(1)),
        (CRDT_CLOCKS_FIELD.into(), Value::Null),
    ]);
    let clock_count = fields
        .iter()
        .filter(|(k, _)| k == CRDT_CLOCKS_FIELD)
        .count();
    assert_eq!(clock_count, 1, "must have exactly one _crdt_clocks field");
}

// ---------------------------------------------------------------------------
// update_fields_at
// ---------------------------------------------------------------------------

#[test]
fn update_fields_at_stamps_only_changed_fields() {
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    let fields = adapter.stamp_insert_at(
        vec![("title".into(), s("old")), ("price".into(), i(10))],
        100,
    );
    let id = col.insert(fields).unwrap();

    adapter
        .update_fields_at(&col, id, vec![("price".into(), i(20))], 200)
        .unwrap();

    let doc = col.find_by_id(id).unwrap().unwrap();
    assert_eq!(doc.get("price"), Some(&i(20)));
    assert_eq!(doc.get("title"), Some(&s("old")));

    // Clock for `price` must be at ts=200, clock for `title` stays at ts=100.
    if let Some(Value::Object(entries)) = doc.get(CRDT_CLOCKS_FIELD) {
        let price_clock = entries.iter().find(|(k, _)| k == "price").unwrap();
        if let Value::Object(clock_fields) = &price_clock.1 {
            let ts = clock_fields
                .iter()
                .find(|(k, _)| k == "t")
                .and_then(|(_, v)| {
                    if let Value::Int(n) = v {
                        Some(*n)
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(ts, 200);
        }
        let title_clock = entries.iter().find(|(k, _)| k == "title").unwrap();
        if let Value::Object(clock_fields) = &title_clock.1 {
            let ts = clock_fields
                .iter()
                .find(|(k, _)| k == "t")
                .and_then(|(_, v)| {
                    if let Value::Int(n) = v {
                        Some(*n)
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(ts, 100);
        }
    } else {
        panic!("_crdt_clocks must be an Object");
    }
}

#[test]
fn update_fields_returns_false_for_missing_doc() {
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();
    let result = adapter
        .update_fields_at(&col, Ulid::new(), vec![("x".into(), i(1))], 100)
        .unwrap();
    assert!(!result);
}

// ---------------------------------------------------------------------------
// Concurrent writes — different fields (the core CRDT property)
// ---------------------------------------------------------------------------

#[test]
fn concurrent_writes_to_different_fields_both_survive() {
    // Simulate: device A sets `title`, device B sets `price` at the same time.
    // After A imports B's changeset and B imports A's, both fields should be present.
    let doc_id = Ulid::new();

    let build_mutation = |field: &str, val: Value, ts: u64, node: &str| FieldMutation {
        field: field.into(),
        value: Some(val),
        clock: FieldClock::new(ts, node),
    };

    // A's view: has title=Hello (written at t=100, node=A)
    let db_a = Database::open_in_memory().unwrap();
    let adapter_a = CrdtSyncAdapter::new("node-a");
    let col_a = db_a.collection("docs").unwrap();
    let fields_a = adapter_a.stamp_insert_at(vec![("title".into(), s("Hello"))], 100);
    let stamped_a = Document::with_id(doc_id, fields_a);
    col_a.insert_with_id(stamped_a).unwrap();

    // B's changeset: sets price=99 on same doc at t=100, node=B
    let b_changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![build_mutation("price", i(99), 100, "node-b")],
        delete_clock: None,
    }];
    let applied = adapter_a.import_crdt_changes(&db_a, b_changeset).unwrap();
    assert_eq!(applied, 1);

    let doc = col_a.find_by_id(doc_id).unwrap().unwrap();
    assert_eq!(
        doc.get("title"),
        Some(&s("Hello")),
        "A's field must survive"
    );
    assert_eq!(doc.get("price"), Some(&i(99)), "B's field must survive");
}

// ---------------------------------------------------------------------------
// Same-field conflict: newer wins, older loses
// ---------------------------------------------------------------------------

#[test]
fn same_field_remote_newer_wins() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    // Local doc: title=old at t=100
    let fields = adapter.stamp_insert_at(vec![("title".into(), s("old"))], 100);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote: title=new at t=200 (newer)
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: "title".into(),
            value: Some(s("new")),
            clock: FieldClock::new(200, "node-b"),
        }],
        delete_clock: None,
    }];
    adapter.import_crdt_changes(&db, changeset).unwrap();

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    assert_eq!(doc.get("title"), Some(&s("new")));
}

#[test]
fn same_field_remote_older_does_not_overwrite() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    // Local doc: title=current at t=200
    let fields = adapter.stamp_insert_at(vec![("title".into(), s("current"))], 200);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote: title=stale at t=100 (older)
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: "title".into(),
            value: Some(s("stale")),
            clock: FieldClock::new(100, "node-b"),
        }],
        delete_clock: None,
    }];
    let applied = adapter.import_crdt_changes(&db, changeset).unwrap();
    assert_eq!(applied, 0, "older remote must not overwrite newer local");

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    assert_eq!(doc.get("title"), Some(&s("current")));
}

// ---------------------------------------------------------------------------
// Timestamp tie broken by node_id
// ---------------------------------------------------------------------------

#[test]
fn timestamp_tie_higher_node_id_wins() {
    // "node-z" > "node-a" lexicographically.
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    let fields = adapter.stamp_insert_at(vec![("x".into(), s("from-a"))], 500);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote has same ts=500 but higher node_id "node-z".
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: "x".into(),
            value: Some(s("from-z")),
            clock: FieldClock::new(500, "node-z"),
        }],
        delete_clock: None,
    }];
    adapter.import_crdt_changes(&db, changeset).unwrap();

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    assert_eq!(doc.get("x"), Some(&s("from-z")), "higher node_id wins tie");
}

#[test]
fn timestamp_tie_lower_node_id_does_not_win() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-z");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    let fields = adapter.stamp_insert_at(vec![("x".into(), s("from-z"))], 500);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote has same ts=500 but lower node_id "node-a".
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: "x".into(),
            value: Some(s("from-a")),
            clock: FieldClock::new(500, "node-a"),
        }],
        delete_clock: None,
    }];
    let applied = adapter.import_crdt_changes(&db, changeset).unwrap();
    assert_eq!(applied, 0, "lower node_id must not win tie");

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    assert_eq!(doc.get("x"), Some(&s("from-z")));
}

// ---------------------------------------------------------------------------
// Field removal (value = None)
// ---------------------------------------------------------------------------

#[test]
fn remote_field_removal_applied_when_newer() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    let fields = adapter.stamp_insert_at(
        vec![("title".into(), s("hi")), ("note".into(), s("bye"))],
        100,
    );
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote removes `note` at t=200.
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: "note".into(),
            value: None,
            clock: FieldClock::new(200, "node-b"),
        }],
        delete_clock: None,
    }];
    adapter.import_crdt_changes(&db, changeset).unwrap();

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    assert_eq!(doc.get("note"), None, "removed field must be absent");
    assert_eq!(
        doc.get("title"),
        Some(&s("hi")),
        "unrelated field untouched"
    );
}

// ---------------------------------------------------------------------------
// G-Set (grow-only set) merge
// ---------------------------------------------------------------------------

#[test]
fn gset_union_preserves_both_sides() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a").with_g_set_fields(["tags"]);
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    // Local: tags=[rust]
    let fields = adapter.stamp_insert_at(vec![("tags".into(), Value::Array(vec![s("rust")]))], 100);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote adds "wasm" to tags (older timestamp — still merges in G-Set).
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: "tags".into(),
            value: Some(Value::Array(vec![s("rust"), s("wasm")])),
            clock: FieldClock::new(50, "node-b"), // older clock
        }],
        delete_clock: None,
    }];
    adapter.import_crdt_changes(&db, changeset).unwrap();

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    if let Some(Value::Array(tags)) = doc.get("tags") {
        assert!(tags.contains(&s("rust")), "rust must survive");
        assert!(tags.contains(&s("wasm")), "wasm must be added (G-Set)");
    } else {
        panic!("tags must be an Array");
    }
}

#[test]
fn gset_no_duplicates_after_merge() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a").with_g_set_fields(["tags"]);
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    let fields = adapter.stamp_insert_at(vec![("tags".into(), Value::Array(vec![s("rust")]))], 100);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote sends same element — union should not duplicate.
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: "tags".into(),
            value: Some(Value::Array(vec![s("rust")])),
            clock: FieldClock::new(200, "node-b"),
        }],
        delete_clock: None,
    }];
    adapter.import_crdt_changes(&db, changeset).unwrap();

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    if let Some(Value::Array(tags)) = doc.get("tags") {
        assert_eq!(tags.len(), 1, "no duplicate entries after G-Set merge");
    } else {
        panic!("tags must be an Array");
    }
}

// ---------------------------------------------------------------------------
// Delete ordering
// ---------------------------------------------------------------------------

#[test]
fn delete_with_newer_clock_removes_doc() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    let fields = adapter.stamp_insert_at(vec![("x".into(), i(1))], 100);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote deletes at t=200 (newer than doc's _changed_at=100).
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: Vec::new(),
        delete_clock: Some(FieldClock::new(200, "node-b")),
    }];
    let applied = adapter.import_crdt_changes(&db, changeset).unwrap();
    assert_eq!(applied, 1);
    assert!(col.find_by_id(doc_id).unwrap().is_none());
}

#[test]
fn delete_with_older_clock_does_not_remove_doc() {
    let doc_id = Ulid::new();
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    // Local doc has _changed_at=500.
    let fields = adapter.stamp_insert_at(vec![("x".into(), i(1))], 500);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Remote deletes at t=100 (older).
    let changeset: CrdtChangeset = vec![CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: Vec::new(),
        delete_clock: Some(FieldClock::new(100, "node-b")),
    }];
    let applied = adapter.import_crdt_changes(&db, changeset).unwrap();
    assert_eq!(applied, 0, "older delete must not remove newer local doc");
    assert!(col.find_by_id(doc_id).unwrap().is_some());
}

// ---------------------------------------------------------------------------
// Export → import round-trip
// ---------------------------------------------------------------------------

#[test]
fn export_import_round_trip() {
    let adapter = CrdtSyncAdapter::new("node-a");
    let src = Database::open_in_memory().unwrap();
    let dst = Database::open_in_memory().unwrap();

    let src_col = src.collection("items").unwrap();
    for n in 0..5i64 {
        let fields = adapter.stamp_insert_at(vec![("n".into(), i(n))], (n as u64 + 1) * 100);
        src_col.insert(fields).unwrap();
    }

    let changeset = adapter.export_crdt_changes(&src, &["items"], 0).unwrap();
    assert_eq!(changeset.len(), 5);

    let applied = adapter.import_crdt_changes(&dst, changeset).unwrap();
    assert_eq!(applied, 5);

    let dst_col = dst.collection("items").unwrap();
    let docs = dst_col.find(Filter::All).unwrap();
    assert_eq!(docs.len(), 5);
}

#[test]
fn export_respects_since_ms() {
    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();

    let fields_old = adapter.stamp_insert_at(vec![("v".into(), i(1))], 100);
    col.insert(fields_old).unwrap();
    let fields_new = adapter.stamp_insert_at(vec![("v".into(), i(2))], 500);
    col.insert(fields_new).unwrap();

    let changeset = adapter.export_crdt_changes(&db, &["items"], 200).unwrap();
    assert_eq!(changeset.len(), 1, "only the doc with ts>200 should export");
    assert_eq!(
        changeset[0].mutations[0].value,
        Some(i(2)),
        "exported value must be the newer doc"
    );
}

// ---------------------------------------------------------------------------
// Three-way merge (three devices, all see full state)
// ---------------------------------------------------------------------------

#[test]
fn three_way_merge_all_fields_survive() {
    let doc_id = Ulid::new();

    // Each device writes a different field at the same time.
    let make_change = |field: &str, val: Value, node: &str| CrdtChange {
        collection: "docs".into(),
        id: doc_id,
        mutations: vec![FieldMutation {
            field: field.into(),
            value: Some(val),
            clock: FieldClock::new(100, node),
        }],
        delete_clock: None,
    };

    let adapter = CrdtSyncAdapter::new("node-a");
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs").unwrap();

    // Start with device A's field.
    let fields = adapter.stamp_insert_at(vec![("a".into(), i(1))], 100);
    let doc = Document::with_id(doc_id, fields);
    col.insert_with_id(doc).unwrap();

    // Import B's and C's changesets.
    let b_changeset = vec![make_change("b", i(2), "node-b")];
    let c_changeset = vec![make_change("c", i(3), "node-c")];

    adapter.import_crdt_changes(&db, b_changeset).unwrap();
    adapter.import_crdt_changes(&db, c_changeset).unwrap();

    let doc = col.find_by_id(doc_id).unwrap().unwrap();
    assert_eq!(doc.get("a"), Some(&i(1)));
    assert_eq!(doc.get("b"), Some(&i(2)));
    assert_eq!(doc.get("c"), Some(&i(3)));
}

// ---------------------------------------------------------------------------
// FieldClock helpers
// ---------------------------------------------------------------------------

#[test]
fn field_clock_dominates_by_timestamp() {
    let newer = FieldClock::new(200, "a");
    let older = FieldClock::new(100, "z"); // higher node_id but older ts
    assert!(newer.dominates(&older));
    assert!(!older.dominates(&newer));
}

#[test]
fn field_clock_dominates_by_node_id_on_tie() {
    let a = FieldClock::new(100, "node-z");
    let b = FieldClock::new(100, "node-a");
    assert!(a.dominates(&b));
    assert!(!b.dominates(&a));
}

#[test]
fn field_clock_does_not_dominate_equal() {
    let a = FieldClock::new(100, "node-a");
    let b = FieldClock::new(100, "node-a");
    assert!(!a.dominates(&b));
}

// ---------------------------------------------------------------------------
// Regression: update_fields → export → import must not propagate as deletion
// ---------------------------------------------------------------------------

/// Previously `update_fields` replaced the doc via delete_by_id +
/// insert_with_id, leaving a tombstone whose timestamp dominated the
/// document's clocks. The next export emitted a delete change that destroyed
/// the updated document on every peer.
#[test]
fn crdt_update_round_trip_does_not_delete_document() {
    let db_a = Database::open_in_memory().unwrap();
    let db_b = Database::open_in_memory().unwrap();
    let col_a = db_a.collection("items").unwrap();
    let col_b = db_b.collection("items").unwrap();
    let adapter_a = CrdtSyncAdapter::new("node-a");
    let adapter_b = CrdtSyncAdapter::new("node-b");

    // A inserts then updates a field.
    let fields = adapter_a.stamp_insert_at(vec![("title".into(), s("v1"))], 100);
    let id = col_a.insert(fields).unwrap();
    adapter_a
        .update_fields_at(&col_a, id, vec![("title".into(), s("v2"))], 200)
        .unwrap();

    // A → B: B must receive the update, and no delete change may be exported.
    let changes = adapter_a.export_crdt_changes(&db_a, &["items"], 0).unwrap();
    assert!(
        !changes
            .iter()
            .any(|c| c.delete_clock.is_some() && c.id == id),
        "update_fields must not generate a delete change on export"
    );
    adapter_b.import_crdt_changes(&db_b, changes).unwrap();
    let doc_b = col_b.find_by_id(id).unwrap().expect("doc must exist on B");
    assert_eq!(doc_b.get("title"), Some(&s("v2")));

    // B → A round trip: document must survive on A.
    let changes_back = adapter_b.export_crdt_changes(&db_b, &["items"], 0).unwrap();
    assert!(
        !changes_back
            .iter()
            .any(|c| c.delete_clock.is_some() && c.id == id),
        "import on B must not generate a delete change for a merged doc"
    );
    adapter_a.import_crdt_changes(&db_a, changes_back).unwrap();
    let doc_a = col_a.find_by_id(id).unwrap();
    assert!(
        doc_a.is_some(),
        "document must survive a full A→B→A CRDT round trip after an update"
    );
    assert_eq!(doc_a.unwrap().get("title"), Some(&s("v2")));
}

/// Stale mutations must not resurrect a document deleted more recently.
#[test]
fn crdt_stale_mutations_do_not_resurrect_newer_deletion() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    let adapter = CrdtSyncAdapter::new("node-local");

    let id = Ulid::new();
    // Remote delete at t=10_000 installs a tombstone.
    adapter
        .import_crdt_changes(
            &db,
            vec![CrdtChange {
                collection: "items".into(),
                id,
                mutations: Vec::new(),
                delete_clock: Some(FieldClock::new(10_000, "node-remote")),
            }],
        )
        .unwrap();

    // Stale mutations (t=5_000) for the same doc arrive afterwards.
    let applied = adapter
        .import_crdt_changes(
            &db,
            vec![CrdtChange {
                collection: "items".into(),
                id,
                mutations: vec![FieldMutation {
                    field: "title".into(),
                    value: Some(s("zombie")),
                    clock: FieldClock::new(5_000, "node-remote"),
                }],
                delete_clock: None,
            }],
        )
        .unwrap();
    assert_eq!(applied, 0, "stale mutations must lose to a newer tombstone");
    assert!(col.find_by_id(id).unwrap().is_none());
}
