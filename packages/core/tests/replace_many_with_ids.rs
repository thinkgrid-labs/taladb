//! `replace_many_with_ids` — the batched, id-addressed upsert that backs
//! replication from a remote origin.
//!
//! The tests that matter most here are the *leakage* ones: a row pulled from an
//! authoritative origin must never replicate back out, and there are two
//! independent channels it could escape through (the push hook, and the
//! `_changed_at` export scan). Both are covered below.

use std::sync::{Arc, Mutex};

use taladb_core::collection::{REMOTE_REVISION_FIELD, WriteOrigin};
use taladb_core::document::{Document, Value, derive_doc_id};
use taladb_core::query::filter::Filter;
use taladb_core::sync::{LastWriteWins, SyncAdapter, SyncEvent, SyncHook};
use taladb_core::{Database, TalaDbError};

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

/// A remote row as the replication coordinator would build it: fields from the
/// origin, `_id` derived from the origin's primary key.
fn remote_doc(collection: &str, key: &str, fields: Vec<(String, Value)>) -> Document {
    Document::with_id(derive_doc_id(collection, key), fields)
}

/// Records every outbound sync event so a test can assert on what would have
/// been pushed to the origin.
#[derive(Default)]
struct RecordingHook {
    events: Mutex<Vec<String>>,
}

impl RecordingHook {
    fn ids(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
}

impl SyncHook for RecordingHook {
    fn on_event(&self, event: SyncEvent) {
        let id = match event {
            SyncEvent::Insert { id, .. } => id,
            SyncEvent::Update { id, .. } => id,
            SyncEvent::Delete { id, .. } => id,
        };
        self.events.lock().unwrap().push(id);
    }
}

// ---------------------------------------------------------------------------
// Leakage: a remote-origin write must never replicate back out
// ---------------------------------------------------------------------------

#[test]
fn authoritative_remote_emits_no_sync_events() {
    let db = Database::open_in_memory().unwrap();
    let hook = Arc::new(RecordingHook::default());
    let products = db
        .collection("products")
        .unwrap()
        .with_sync_hook(hook.clone());

    products
        .replace_many_with_ids(
            vec![
                remote_doc("products", "sku-1", vec![("name".into(), s("Mug"))]),
                remote_doc("products", "sku-2", vec![("name".into(), s("Pan"))]),
            ],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();

    assert!(
        hook.ids().is_empty(),
        "a remote-origin write must not fire the push hook — replaying the \
         origin's own rows back at it is a write loop, got {:?}",
        hook.ids()
    );
}

#[test]
fn authoritative_remote_is_not_picked_up_by_export_changes() {
    // The push hook is only one of two escape routes. `export_changes` selects on
    // `Gt("_changed_at", since)` and never consults the hook, so suppressing
    // events alone would still let `db.sync()` push origin rows as user edits.
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();

    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("name".into(), s("Mug"))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();

    let adapter = LastWriteWins::new();
    let changes = adapter.export_changes(&db, &["products"], 0).unwrap();

    assert!(
        changes.is_empty(),
        "remote-origin rows must be invisible to export_changes, else the next \
         db.sync() push sends the origin its own data back; got {} change(s)",
        changes.len()
    );
}

#[test]
fn authoritative_remote_delete_leaves_no_exportable_tombstone() {
    // The third escape route. `export_changes` scans the tombstone table directly
    // and cannot filter it by provenance — the document is gone by then — so a
    // remote delete must not write a tombstone at all.
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    let id = derive_doc_id("products", "sku-1");

    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("name".into(), s("Mug"))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();
    let removed = products
        .delete_many_with_ids(&[id], WriteOrigin::AuthoritativeRemote)
        .unwrap();

    assert_eq!(removed, 1);
    assert!(products.find_by_id(id).unwrap().is_none());

    let changes = LastWriteWins::new()
        .export_changes(&db, &["products"], 0)
        .unwrap();
    assert!(
        changes.is_empty(),
        "a remote delete must not produce an exportable tombstone, else the next \
         push tells the origin to delete a row it deleted itself; got {changes:?}"
    );
}

#[test]
fn local_delete_still_writes_an_exportable_tombstone() {
    let db = Database::open_in_memory().unwrap();
    let notes = db.collection("notes").unwrap();
    let id = notes.insert(vec![("body".into(), s("hi"))]).unwrap();

    let removed = notes
        .delete_many_with_ids(&[id], WriteOrigin::Local)
        .unwrap();
    assert_eq!(removed, 1);

    let changes = LastWriteWins::new()
        .export_changes(&db, &["notes"], 0)
        .unwrap();
    assert_eq!(
        changes.len(),
        1,
        "a local delete must still propagate to peers as a tombstone"
    );
}

#[test]
fn delete_many_with_ids_skips_unknown_ids() {
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    let removed = products
        .delete_many_with_ids(
            &[derive_doc_id("products", "never-existed")],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();
    assert_eq!(removed, 0);
}

#[test]
fn local_origin_still_emits_and_exports() {
    // The guard above must not have broken the ordinary local write path.
    let db = Database::open_in_memory().unwrap();
    let hook = Arc::new(RecordingHook::default());
    let notes = db.collection("notes").unwrap().with_sync_hook(hook.clone());

    let ids = notes
        .replace_many_with_ids(
            vec![remote_doc("notes", "n-1", vec![("body".into(), s("hi"))])],
            WriteOrigin::Local,
        )
        .unwrap();

    assert_eq!(hook.ids(), vec![ids[0].to_string()]);

    let changes = LastWriteWins::new()
        .export_changes(&db, &["notes"], 0)
        .unwrap();
    assert_eq!(changes.len(), 1, "a local write must still export to peers");
}

// ---------------------------------------------------------------------------
// Upsert semantics: idempotent, merging, id-stable
// ---------------------------------------------------------------------------

#[test]
fn is_idempotent_by_derived_id() {
    // Re-applying the same remote row (a bridge fetch, then the bootstrap walk
    // reaching the same page) must converge on one document, not two.
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    let doc = || remote_doc("products", "sku-1", vec![("name".into(), s("Mug"))]);

    let first = products
        .replace_many_with_ids(vec![doc()], WriteOrigin::AuthoritativeRemote)
        .unwrap();
    let second = products
        .replace_many_with_ids(vec![doc()], WriteOrigin::AuthoritativeRemote)
        .unwrap();

    assert_eq!(first, second, "the derived id must be stable across passes");
    assert_eq!(
        products.find(Filter::All).unwrap().len(),
        1,
        "re-applying the same row must replace it, not duplicate it"
    );
}

#[test]
fn later_pages_merge_rather_than_wipe_earlier_ones() {
    // The headline guarantee: hydrating page 2 must leave page 1 alone.
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();

    products
        .replace_many_with_ids(
            vec![remote_doc("products", "sku-1", vec![("page".into(), i(1))])],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();
    products
        .replace_many_with_ids(
            vec![remote_doc("products", "sku-2", vec![("page".into(), i(2))])],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();

    assert_eq!(products.find(Filter::All).unwrap().len(), 2);
    assert!(
        products
            .find_by_id(derive_doc_id("products", "sku-1"))
            .unwrap()
            .is_some(),
        "page 1's rows must survive page 2 landing"
    );
}

#[test]
fn replaces_existing_row_in_place() {
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();

    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("price".into(), i(500))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();
    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("price".into(), i(300))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();

    let doc = products
        .find_by_id(derive_doc_id("products", "sku-1"))
        .unwrap()
        .expect("row present");
    assert_eq!(doc.get("price"), Some(&Value::Int(300)));
}

#[test]
fn authoritative_revision_rejects_a_late_stale_response() {
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    let row = |rev, price| {
        remote_doc(
            "products",
            "sku-1",
            vec![
                (REMOTE_REVISION_FIELD.into(), i(rev)),
                ("price".into(), i(price)),
            ],
        )
    };

    products
        .replace_many_with_ids(vec![row(5, 500)], WriteOrigin::AuthoritativeRemote)
        .unwrap();
    let applied = products
        .replace_many_with_ids(vec![row(4, 400)], WriteOrigin::AuthoritativeRemote)
        .unwrap();

    assert!(applied.is_empty());
    assert_eq!(
        products
            .find_by_id(derive_doc_id("products", "sku-1"))
            .unwrap()
            .unwrap()
            .get("price"),
        Some(&i(500))
    );
}

#[test]
fn editing_a_remote_row_locally_makes_it_exportable() {
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("price".into(), i(100))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();

    products
        .update_one(
            Filter::Eq(
                "_id".into(),
                s(&derive_doc_id("products", "sku-1").to_string()),
            ),
            taladb_core::Update::Set(vec![("price".into(), i(200))]),
        )
        .unwrap();

    let changes = LastWriteWins::new()
        .export_changes(&db, &["products"], 0)
        .unwrap();
    assert_eq!(changes.len(), 1);
}

#[test]
fn empty_batch_is_a_no_op() {
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    let ids = products
        .replace_many_with_ids(vec![], WriteOrigin::AuthoritativeRemote)
        .unwrap();
    assert!(ids.is_empty());
}

// ---------------------------------------------------------------------------
// Index maintenance and tombstones
// ---------------------------------------------------------------------------

#[test]
fn secondary_indexes_are_rebuilt_against_the_old_version() {
    // A stale index entry pointing at the *previous* field value would make the
    // row findable under a value it no longer has.
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    products.create_index("category").unwrap();

    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("category".into(), s("kitchen"))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();
    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("category".into(), s("garden"))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();

    let stale = products
        .find(Filter::Eq("category".into(), s("kitchen")))
        .unwrap();
    assert!(
        stale.is_empty(),
        "the old index entry must be removed, not left dangling"
    );
    let fresh = products
        .find(Filter::Eq("category".into(), s("garden")))
        .unwrap();
    assert_eq!(fresh.len(), 1);
}

#[test]
fn clears_a_tombstone_so_a_deleted_row_can_come_back() {
    // A delta refresh may delete a row and a later one resurrect it. If the
    // tombstone outlived the replace, the next export would re-delete it on peers.
    let db = Database::open_in_memory().unwrap();
    let products = db.collection("products").unwrap();
    let id = derive_doc_id("products", "sku-1");

    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("name".into(), s("Mug"))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();
    products.delete_by_id(id).unwrap();
    assert!(products.find_by_id(id).unwrap().is_none());

    products
        .replace_many_with_ids(
            vec![remote_doc(
                "products",
                "sku-1",
                vec![("name".into(), s("Mug"))],
            )],
            WriteOrigin::AuthoritativeRemote,
        )
        .unwrap();

    assert!(
        products.find_by_id(id).unwrap().is_some(),
        "the row must be alive again after being re-replaced"
    );
}

// ---------------------------------------------------------------------------
// System collection
// ---------------------------------------------------------------------------

#[test]
fn replica_coverage_collection_is_addressable_but_hidden() {
    let db = Database::open_in_memory().unwrap();

    // The coordinator persists coverage through the ordinary collection API.
    let replica = db.collection("__taladb_replica").unwrap();
    replica
        .insert(vec![("scope".into(), s("products@store:123"))])
        .unwrap();

    // …but it is a system collection: it must not show up as user data, or it
    // would be swept into the default "sync all" set.
    let names = db.list_collection_names().unwrap();
    assert!(
        !names.contains(&"__taladb_replica".to_string()),
        "the coverage store must stay hidden from listCollectionNames, got {names:?}"
    );

    // Other underscore names remain reserved.
    assert!(matches!(
        db.collection("_not_allowed"),
        Err(TalaDbError::InvalidName(_))
    ));
}
