use taladb_core::engine::{RedbBackend, WriteTxn};
use taladb_core::error::TalaDbError;
use taladb_core::{Database, Filter, Migration, StorageBackend, Value};

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

/// Build an in-memory Database after running a set of migrations.
fn open_migrated(migrations: &[Migration]) -> Database {
    let backend = RedbBackend::open_in_memory().unwrap();
    taladb_core::migration::run_migrations(&backend, migrations).unwrap();
    Database::open_with_backend(Box::new(backend)).unwrap()
}

// ---------------------------------------------------------------------------
// Basic migration execution
// ---------------------------------------------------------------------------

#[test]
fn empty_migrations_list_opens_cleanly() {
    let db = open_migrated(&[]);
    db.collection("test")
        .unwrap()
        .insert(vec![("x".into(), i(1))])
        .unwrap();
    assert_eq!(
        db.collection("test").unwrap().count(Filter::All).unwrap(),
        1
    );
}

#[test]
fn single_migration_runs_on_fresh_db() {
    fn m1(txn: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        txn.put("meta::flags", b"migrated", b"\x01")
    }

    let backend = RedbBackend::open_in_memory().unwrap();
    taladb_core::migration::run_migrations(
        &backend,
        &[Migration {
            from_version: 0,
            to_version: 1,
            description: "m1",
            up: m1,
        }],
    )
    .unwrap();

    // Version should now be 1
    let rtxn = backend.begin_read().unwrap();
    let version = taladb_core::migration::read_version(rtxn.as_ref()).unwrap();
    assert_eq!(version, 1);
}

#[test]
fn two_migrations_run_in_order() {
    static ORDER: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

    fn m1(txn: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        ORDER.lock().unwrap().push(1);
        txn.put("meta::order", b"step1", b"1")
    }
    fn m2(txn: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        ORDER.lock().unwrap().push(2);
        txn.put("meta::order", b"step2", b"2")
    }

    let backend = RedbBackend::open_in_memory().unwrap();
    taladb_core::migration::run_migrations(
        &backend,
        &[
            Migration {
                from_version: 0,
                to_version: 1,
                description: "m1",
                up: m1,
            },
            Migration {
                from_version: 1,
                to_version: 2,
                description: "m2",
                up: m2,
            },
        ],
    )
    .unwrap();

    let rtxn = backend.begin_read().unwrap();
    let version = taladb_core::migration::read_version(rtxn.as_ref()).unwrap();
    assert_eq!(version, 2);

    let order = ORDER.lock().unwrap().clone();
    assert_eq!(order, vec![1, 2]);
}

#[test]
fn already_applied_migration_is_skipped() {
    fn m1(txn: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        txn.put("meta::test", b"k", b"v")
    }

    let backend = RedbBackend::open_in_memory().unwrap();
    let migrations = [Migration {
        from_version: 0,
        to_version: 1,
        description: "m1",
        up: m1,
    }];

    // First run
    taladb_core::migration::run_migrations(&backend, &migrations).unwrap();
    // Second run with same list — must be a no-op, not an error
    taladb_core::migration::run_migrations(&backend, &migrations).unwrap();

    let rtxn = backend.begin_read().unwrap();
    let version = taladb_core::migration::read_version(rtxn.as_ref()).unwrap();
    assert_eq!(version, 1);
}

#[test]
fn second_open_only_runs_pending_migration() {
    fn m1(txn: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        txn.put("meta::test", b"m1", b"1")
    }
    fn m2(txn: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        txn.put("meta::test", b"m2", b"2")
    }

    let backend = RedbBackend::open_in_memory().unwrap();

    // First open: only m1
    taladb_core::migration::run_migrations(
        &backend,
        &[Migration {
            from_version: 0,
            to_version: 1,
            description: "m1",
            up: m1,
        }],
    )
    .unwrap();

    // Second open: m1 + m2 — only m2 should run
    taladb_core::migration::run_migrations(
        &backend,
        &[
            Migration {
                from_version: 0,
                to_version: 1,
                description: "m1",
                up: m1,
            },
            Migration {
                from_version: 1,
                to_version: 2,
                description: "m2",
                up: m2,
            },
        ],
    )
    .unwrap();

    let rtxn = backend.begin_read().unwrap();
    let version = taladb_core::migration::read_version(rtxn.as_ref()).unwrap();
    assert_eq!(version, 2);
}

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

#[test]
fn gap_in_migration_chain_returns_error() {
    fn noop(_: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        Ok(())
    }

    let backend = RedbBackend::open_in_memory().unwrap();
    let result = taladb_core::migration::run_migrations(
        &backend,
        &[
            Migration {
                from_version: 0,
                to_version: 1,
                description: "m1",
                up: noop,
            },
            // Gap: from_version 3 ≠ previous to_version 1
            Migration {
                from_version: 3,
                to_version: 4,
                description: "m3",
                up: noop,
            },
        ],
    );

    assert!(
        result.is_err(),
        "gap in migration chain must return an error"
    );
}

// ---------------------------------------------------------------------------
// Integration: migration that creates indexes
// ---------------------------------------------------------------------------

#[test]
fn post_migration_db_accepts_collection_index() {
    fn noop(_: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        Ok(())
    }

    let db = open_migrated(&[Migration {
        from_version: 0,
        to_version: 1,
        description: "init",
        up: noop,
    }]);

    let users = db.collection("users").unwrap();
    users.create_index("email").unwrap();
    users
        .insert(vec![
            ("email".into(), s("alice@example.com")),
            ("age".into(), i(30)),
        ])
        .unwrap();

    let result = users
        .find(Filter::Eq("email".into(), s("alice@example.com")))
        .unwrap();
    assert_eq!(result.len(), 1);
}

// ---------------------------------------------------------------------------
// Out-of-order migration versions return an error
// ---------------------------------------------------------------------------

#[test]
fn out_of_order_migration_versions_returns_error() {
    fn noop(_: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        Ok(())
    }

    let backend = RedbBackend::open_in_memory().unwrap();
    // from_version 1 before from_version 0 — not in chain order
    let result = taladb_core::migration::run_migrations(
        &backend,
        &[
            Migration {
                from_version: 1,
                to_version: 2,
                description: "m2_first",
                up: noop,
            },
            Migration {
                from_version: 0,
                to_version: 1,
                description: "m1_second",
                up: noop,
            },
        ],
    );

    assert!(
        result.is_err(),
        "out-of-order migrations must return an error"
    );
}

// ---------------------------------------------------------------------------
// Snapshot round-trip after migrations
// ---------------------------------------------------------------------------

#[test]
fn snapshot_after_migration_restores_correctly() {
    fn noop(_: &mut dyn WriteTxn) -> Result<(), TalaDbError> {
        Ok(())
    }

    let db = open_migrated(&[Migration {
        from_version: 0,
        to_version: 1,
        description: "seed",
        up: noop,
    }]);

    db.collection("items")
        .unwrap()
        .insert(vec![("v".into(), i(1))])
        .unwrap();
    db.collection("items")
        .unwrap()
        .insert(vec![("v".into(), i(2))])
        .unwrap();

    let snapshot = db.export_snapshot().unwrap();
    let db2 = Database::restore_from_snapshot(&snapshot).unwrap();

    assert_eq!(
        db2.collection("items").unwrap().count(Filter::All).unwrap(),
        2
    );
}

// ---------------------------------------------------------------------------
// Application migration version store (user_version / set_user_version)
// ---------------------------------------------------------------------------

#[test]
fn user_version_defaults_to_zero() {
    let db = open_migrated(&[]);
    assert_eq!(db.user_version().unwrap(), 0);
}

#[test]
fn user_version_persists_across_reopen() {
    // Rust drops the Database at scope end, deterministically releasing the
    // redb file lock — so we can reopen the SAME path in-process (unlike JS,
    // where GC timing forbids it). This proves the counter is durable.
    let dir = std::env::temp_dir().join(format!("taladb-uv-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("uv.db");

    {
        let db = Database::open(&path).unwrap();
        assert_eq!(db.user_version().unwrap(), 0);
        db.set_user_version(3).unwrap();
        assert_eq!(db.user_version().unwrap(), 3);
    }
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(db.user_version().unwrap(), 3, "must survive reopen");
        db.set_user_version(5).unwrap();
    }
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(db.user_version().unwrap(), 5);
    }

    std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// Configurable durability (set_durability / flush)
// ---------------------------------------------------------------------------

#[test]
fn eventual_durability_then_flush_persists_across_reopen() {
    // Eventual durability batches fsync; an explicit flush() must make prior
    // writes durable so they survive a reopen. Rust drops the handle
    // deterministically, releasing the file lock.
    let dir = std::env::temp_dir().join(format!("taladb-dur-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("dur.db");

    {
        let db = Database::open(&path).unwrap();
        db.set_durability(true); // eventual — batched
        db.collection("items")
            .unwrap()
            .insert(vec![("n".into(), i(1))])
            .unwrap();
        db.flush().unwrap(); // force durable
    }
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.collection("items").unwrap().count(Filter::All).unwrap(),
            1,
            "flushed eventual write must survive reopen"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn immediate_durability_is_the_default_and_flush_is_a_noop() {
    // Default (immediate) writes are durable without an explicit flush; flush()
    // is safe to call regardless.
    let dir = std::env::temp_dir().join(format!("taladb-dur2-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("imm.db");

    {
        let db = Database::open(&path).unwrap();
        db.collection("c")
            .unwrap()
            .insert(vec![("x".into(), i(7))])
            .unwrap();
        db.flush().unwrap(); // no-op under immediate durability
    }
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(db.collection("c").unwrap().count(Filter::All).unwrap(), 1);
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn in_memory_flush_and_set_durability_are_harmless() {
    let db = Database::open_in_memory().unwrap();
    db.set_durability(true);
    db.collection("m")
        .unwrap()
        .insert(vec![("a".into(), i(1))])
        .unwrap();
    db.flush().unwrap(); // no-op on in-memory
    assert_eq!(db.collection("m").unwrap().count(Filter::All).unwrap(), 1);
}
