//! Edge cases, boundary conditions, and regression guards.
use taladb_core::{Database, Filter, Update, Value};

fn s(v: &str) -> Value { Value::Str(v.to_string()) }
fn i(n: i64) -> Value { Value::Int(n) }

// ---------------------------------------------------------------------------
// Empty / zero values
// ---------------------------------------------------------------------------

#[test]
fn empty_string_is_valid_field_value() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs");

    col.insert(vec![("bio".into(), s(""))]).unwrap();
    let doc = col.find_one(Filter::Eq("bio".into(), s(""))).unwrap().unwrap();
    assert_eq!(doc.get("bio"), Some(&s("")));
}

#[test]
fn zero_integer_is_valid_and_findable() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("counters");

    col.insert(vec![("count".into(), i(0))]).unwrap();
    col.create_index("count").unwrap();

    let results = col.find(Filter::Eq("count".into(), i(0))).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn negative_integer_sorts_below_zero() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("temps");

    col.create_index("temp").unwrap();
    for t in [-10i64, -5, 0, 5, 10] {
        col.insert(vec![("temp".into(), i(t))]).unwrap();
    }

    let cold = col.find(Filter::Lt("temp".into(), i(0))).unwrap();
    assert_eq!(cold.len(), 2);
    for doc in &cold {
        assert!(doc.get("temp").unwrap().as_int().unwrap() < 0);
    }

    let warm = col.find(Filter::Gte("temp".into(), i(0))).unwrap();
    assert_eq!(warm.len(), 3);
}

#[test]
fn i64_min_and_max_round_trip() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("extremes");

    col.create_index("n").unwrap();
    col.insert(vec![("n".into(), i(i64::MIN))]).unwrap();
    col.insert(vec![("n".into(), i(i64::MAX))]).unwrap();

    let all = col.find(Filter::All).unwrap();
    assert_eq!(all.len(), 2);

    // Range scan must include both
    let results = col.find(Filter::And(vec![
        Filter::Gte("n".into(), i(i64::MIN)),
        Filter::Lte("n".into(), i(i64::MAX)),
    ])).unwrap();
    assert_eq!(results.len(), 2);
}

// ---------------------------------------------------------------------------
// Large documents and collections
// ---------------------------------------------------------------------------

#[test]
fn document_with_many_fields_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("wide");

    let fields: Vec<(String, Value)> = (0..100)
        .map(|n| (format!("field_{n}"), i(n)))
        .collect();

    col.insert(fields.clone()).unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    for (key, val) in &fields {
        assert_eq!(doc.get(key.as_str()), Some(val), "field {key} missing");
    }
}

#[test]
fn large_string_value_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("blobs");

    let big = "x".repeat(64 * 1024); // 64 KB string
    col.insert(vec![("data".into(), Value::Str(big.clone()))]).unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("data"), Some(&Value::Str(big)));
}

#[test]
fn insert_and_delete_1000_documents() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("bulk");

    col.create_index("n").unwrap();
    let items: Vec<Vec<(String, Value)>> = (0i64..1000)
        .map(|n| vec![("n".into(), i(n))])
        .collect();
    col.insert_many(items).unwrap();

    assert_eq!(col.count(Filter::All).unwrap(), 1000);

    let deleted = col.delete_many(Filter::Lt("n".into(), i(500))).unwrap();
    assert_eq!(deleted, 500);
    assert_eq!(col.count(Filter::All).unwrap(), 500);

    // Index still accurate after mass delete
    let results = col.find(Filter::Gte("n".into(), i(500))).unwrap();
    assert_eq!(results.len(), 500);
}

// ---------------------------------------------------------------------------
// Update preserves untouched fields
// ---------------------------------------------------------------------------

#[test]
fn update_set_preserves_other_fields() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![
        ("name".into(), s("Alice")),
        ("email".into(), s("alice@example.com")),
        ("age".into(), i(30)),
    ]).unwrap();

    col.update_one(
        Filter::Eq("name".into(), s("Alice")),
        Update::Set(vec![("age".into(), i(31))]),
    ).unwrap();

    let doc = col.find_one(Filter::Eq("name".into(), s("Alice"))).unwrap().unwrap();
    assert_eq!(doc.get("name"),  Some(&s("Alice")));
    assert_eq!(doc.get("email"), Some(&s("alice@example.com")));
    assert_eq!(doc.get("age"),   Some(&i(31)));
}

#[test]
fn update_inc_does_not_affect_other_numeric_fields() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("stats");

    col.insert(vec![
        ("views".into(), i(100)),
        ("likes".into(), i(50)),
    ]).unwrap();

    col.update_one(Filter::All, Update::Inc(vec![("views".into(), i(1))])).unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("views"), Some(&i(101)));
    assert_eq!(doc.get("likes"), Some(&i(50)));
}

// ---------------------------------------------------------------------------
// Delete by ID
// ---------------------------------------------------------------------------

#[test]
fn delete_by_unique_field_removes_only_target_document() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), s("Alice")), ("uid".into(), i(1))]).unwrap();
    col.insert(vec![("name".into(), s("Bob")),   ("uid".into(), i(2))]).unwrap();

    col.delete_one(Filter::Eq("uid".into(), i(1))).unwrap();

    assert_eq!(col.count(Filter::All).unwrap(), 1);
    let remaining = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(remaining.get("name"), Some(&s("Bob")));
}

// ---------------------------------------------------------------------------
// find_one returns first inserted (ULID order)
// ---------------------------------------------------------------------------

#[test]
fn find_one_returns_earliest_insertion() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("events");

    col.insert(vec![("seq".into(), i(1)), ("type".into(), s("click"))]).unwrap();
    col.insert(vec![("seq".into(), i(2)), ("type".into(), s("click"))]).unwrap();
    col.insert(vec![("seq".into(), i(3)), ("type".into(), s("click"))]).unwrap();

    let first = col.find_one(Filter::Eq("type".into(), s("click"))).unwrap().unwrap();
    assert_eq!(first.get("seq"), Some(&i(1)));
}

// ---------------------------------------------------------------------------
// Cross-type queries return no results (no implicit coercion)
// ---------------------------------------------------------------------------

#[test]
fn int_field_does_not_match_string_query() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs");

    col.insert(vec![("val".into(), i(42))]).unwrap();

    let results = col.find(Filter::Eq("val".into(), s("42"))).unwrap();
    assert!(results.is_empty(), "int field must not match string value");
}

// ---------------------------------------------------------------------------
// Compound And + Or nesting
// ---------------------------------------------------------------------------

#[test]
fn nested_and_or_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("role".into(), s("admin")),  ("active".into(), Value::Bool(true))]).unwrap();
    col.insert(vec![("role".into(), s("admin")),  ("active".into(), Value::Bool(false))]).unwrap();
    col.insert(vec![("role".into(), s("editor")), ("active".into(), Value::Bool(true))]).unwrap();
    col.insert(vec![("role".into(), s("viewer")), ("active".into(), Value::Bool(true))]).unwrap();

    // (role = admin AND active = true) OR (role = editor AND active = true)
    let results = col.find(Filter::Or(vec![
        Filter::And(vec![
            Filter::Eq("role".into(), s("admin")),
            Filter::Eq("active".into(), Value::Bool(true)),
        ]),
        Filter::And(vec![
            Filter::Eq("role".into(), s("editor")),
            Filter::Eq("active".into(), Value::Bool(true)),
        ]),
    ])).unwrap();

    assert_eq!(results.len(), 2);
    for doc in &results {
        assert_eq!(doc.get("active"), Some(&Value::Bool(true)));
    }
}

// ---------------------------------------------------------------------------
// Snapshot faithfulness after writes
// ---------------------------------------------------------------------------

#[test]
fn snapshot_captures_state_at_export_time() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert(vec![("v".into(), i(1))]).unwrap();
    col.insert(vec![("v".into(), i(2))]).unwrap();

    let snapshot = db.export_snapshot().unwrap();

    // Write more docs after the snapshot
    col.insert(vec![("v".into(), i(3))]).unwrap();

    let db2 = Database::restore_from_snapshot(&snapshot).unwrap();
    assert_eq!(db2.collection("items").count(Filter::All).unwrap(), 2,
        "snapshot must not include post-export writes");
}
