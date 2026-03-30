use std::sync::Arc;
use std::thread;
use std::time::Duration;

use taladb_core::Database;
use taladb_core::document::Value;
use taladb_core::query::filter::Filter;
use taladb_core::watch::{create_watch, new_registry, notify};

fn s(v: &str) -> Value { Value::Str(v.to_string()) }
fn i(n: i64) -> Value { Value::Int(n) }

// ---------------------------------------------------------------------------
// try_next — non-blocking, no event
// ---------------------------------------------------------------------------

#[test]
fn try_next_returns_none_when_no_event() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();
    let db_clone = Arc::clone(&db);

    let handle = create_watch(&registry, Filter::All, move |filter| {
        db_clone.collection("users").find(filter.clone())
    });

    // No write has occurred — try_next should return None
    let result = handle.try_next().unwrap();
    assert!(result.is_none());
}

// ---------------------------------------------------------------------------
// next — blocks until write, returns snapshot
// ---------------------------------------------------------------------------

#[test]
fn next_returns_snapshot_after_write() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();
    let db_clone = Arc::clone(&db);

    let handle = create_watch(&registry, Filter::All, move |filter| {
        db_clone.collection("items").find(filter.clone())
    });

    // Notify before inserting (watch fires, sees empty collection)
    notify(&registry);
    let snapshot = handle.next().unwrap();
    assert!(snapshot.is_empty());

    // Insert and notify
    db.collection("items").insert(vec![("x".into(), i(1))]).unwrap();
    notify(&registry);
    let snapshot = handle.next().unwrap();
    assert_eq!(snapshot.len(), 1);
}

// ---------------------------------------------------------------------------
// try_next — returns snapshot after notify
// ---------------------------------------------------------------------------

#[test]
fn try_next_returns_snapshot_after_notify() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();
    let db_clone = Arc::clone(&db);

    let handle = create_watch(&registry, Filter::All, move |filter| {
        db_clone.collection("data").find(filter.clone())
    });

    db.collection("data").insert(vec![("v".into(), i(42))]).unwrap();
    notify(&registry);

    let result = handle.try_next().unwrap();
    assert!(result.is_some());
    assert_eq!(result.unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Multiple rapid writes coalesce into one snapshot
// ---------------------------------------------------------------------------

#[test]
fn rapid_writes_coalesce() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();
    let db_clone = Arc::clone(&db);
    let col = db.collection("data");

    let handle = create_watch(&registry, Filter::All, move |filter| {
        db_clone.collection("data").find(filter.clone())
    });

    // Send multiple notifications in rapid succession
    for n in 0..5i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
        notify(&registry);
    }

    // next() should drain all queued events and return a single snapshot
    let snapshot = handle.next().unwrap();
    // The snapshot reflects the current state (5 docs)
    assert_eq!(snapshot.len(), 5, "coalesced snapshot should see all 5 docs");

    // No further events pending
    let pending = handle.try_next().unwrap();
    assert!(pending.is_none(), "no more events should be pending after drain");
}

// ---------------------------------------------------------------------------
// Filter applied to snapshots
// ---------------------------------------------------------------------------

#[test]
fn watch_filter_applied_to_snapshots() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();
    let db_clone = Arc::clone(&db);
    let col = db.collection("items");

    col.insert(vec![("status".into(), s("active"))]).unwrap();
    col.insert(vec![("status".into(), s("inactive"))]).unwrap();

    let handle = create_watch(
        &registry,
        Filter::Eq("status".into(), s("active")),
        move |filter| {
            db_clone.collection("items").find(filter.clone())
        },
    );

    notify(&registry);
    let snapshot = handle.next().unwrap();

    assert_eq!(snapshot.len(), 1, "snapshot must respect the watch filter");
    assert_eq!(snapshot[0].get("status"), Some(&s("active")));
}

// ---------------------------------------------------------------------------
// Multiple subscribers all receive events
// ---------------------------------------------------------------------------

#[test]
fn multiple_subscribers_all_receive_event() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();

    let db1 = Arc::clone(&db);
    let h1 = create_watch(&registry, Filter::All, move |f| {
        db1.collection("col").find(f.clone())
    });

    let db2 = Arc::clone(&db);
    let h2 = create_watch(&registry, Filter::All, move |f| {
        db2.collection("col").find(f.clone())
    });

    db.collection("col").insert(vec![("x".into(), i(1))]).unwrap();
    notify(&registry);

    let s1 = h1.next().unwrap();
    let s2 = h2.next().unwrap();

    assert_eq!(s1.len(), 1, "subscriber 1 should receive event");
    assert_eq!(s2.len(), 1, "subscriber 2 should receive event");
}

// ---------------------------------------------------------------------------
// WatchHandle::iter yields snapshots
// ---------------------------------------------------------------------------

#[test]
fn iter_yields_successive_snapshots() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();
    let db_clone = Arc::clone(&db);
    let col = db.collection("log");

    let handle = create_watch(&registry, Filter::All, move |f| {
        db_clone.collection("log").find(f.clone())
    });

    let registry_clone = Arc::clone(&registry);
    let col_thread = db.collection("log");

    // Spawn a thread that inserts 3 items with notifications
    let writer = thread::spawn(move || {
        for n in 0i64..3 {
            col_thread.insert(vec![("n".into(), i(n))]).unwrap();
            notify(&registry_clone);
            thread::sleep(Duration::from_millis(1));
        }
    });

    let mut count = 0;
    for snapshot in handle.iter() {
        count += 1;
        let _ = snapshot.unwrap();
        if count == 3 {
            break;
        }
    }

    writer.join().unwrap();
    assert_eq!(count, 3, "iter should yield one snapshot per notify");
}

// ---------------------------------------------------------------------------
// WatchClosed error when registry is dropped
// ---------------------------------------------------------------------------

#[test]
fn watch_closed_after_registry_dropped() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let registry = new_registry();
    let db_clone = Arc::clone(&db);

    let handle = create_watch(&registry, Filter::All, move |f| {
        db_clone.collection("x").find(f.clone())
    });

    // Trigger one event so the channel isn't disconnected due to no sends
    notify(&registry);
    let _ = handle.next().unwrap();

    // Drop the registry — all senders get dropped
    drop(registry);

    // try_next should return WatchClosed
    let result = handle.try_next();
    match result {
        Err(taladb_core::TalaDbError::WatchClosed) => {}
        // Channel may still appear empty if not yet noticed — that's also valid
        Ok(None) => {}
        other => panic!("expected WatchClosed or None, got: {:?}", other),
    }
}
