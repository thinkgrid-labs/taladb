use taladb_core::{Database, Filter, Update, Value};

fn i(n: i64) -> Value {
    Value::Int(n)
}
fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn b(x: bool) -> Value {
    Value::Bool(x)
}
fn f(x: f64) -> Value {
    Value::Float(x)
}

// ---------------------------------------------------------------------------
// Basic index lookups
// ---------------------------------------------------------------------------

#[test]
fn index_eq_lookup() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![
        ("email".into(), s("alice@example.com")),
        ("age".into(), i(30)),
    ])
    .unwrap();
    col.insert(vec![
        ("email".into(), s("bob@example.com")),
        ("age".into(), i(25)),
    ])
    .unwrap();
    col.create_index("email").unwrap();

    let results = col
        .find(Filter::Eq("email".into(), s("alice@example.com")))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("email"), Some(&s("alice@example.com")));
}

#[test]
fn index_range_gte() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("products");

    for price in [10, 20, 30, 40, 50] {
        col.insert(vec![("price".into(), i(price))]).unwrap();
    }
    col.create_index("price").unwrap();

    let results = col.find(Filter::Gte("price".into(), i(30))).unwrap();
    assert_eq!(results.len(), 3);
    for doc in &results {
        assert!(doc.get("price").unwrap().as_int().unwrap() >= 30);
    }
}

#[test]
fn index_range_lte() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("products");

    for price in [10, 20, 30, 40, 50] {
        col.insert(vec![("price".into(), i(price))]).unwrap();
    }
    col.create_index("price").unwrap();

    let results = col.find(Filter::Lte("price".into(), i(20))).unwrap();
    assert_eq!(results.len(), 2);
    for doc in &results {
        assert!(doc.get("price").unwrap().as_int().unwrap() <= 20);
    }
}

#[test]
fn index_range_exclusive_bounds() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("scores");

    for n in [10i64, 20, 30, 40, 50] {
        col.insert(vec![("score".into(), i(n))]).unwrap();
    }
    col.create_index("score").unwrap();

    let gt = col.find(Filter::Gt("score".into(), i(20))).unwrap();
    assert_eq!(gt.len(), 3);

    let lt = col.find(Filter::Lt("score".into(), i(40))).unwrap();
    assert_eq!(lt.len(), 3);
}

#[test]
fn index_range_between() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("ages");

    for age in [15i64, 18, 25, 30, 65, 70] {
        col.insert(vec![("age".into(), i(age))]).unwrap();
    }
    col.create_index("age").unwrap();

    let results = col
        .find(Filter::And(vec![
            Filter::Gte("age".into(), i(18)),
            Filter::Lte("age".into(), i(65)),
        ]))
        .unwrap();

    assert_eq!(results.len(), 4);
    for doc in &results {
        let age = doc.get("age").unwrap().as_int().unwrap();
        assert!(age >= 18 && age <= 65, "age {age} out of range");
    }
}

#[test]
fn index_in_lookup() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    for status in ["active", "pending", "deleted", "archived"] {
        col.insert(vec![("status".into(), s(status))]).unwrap();
    }
    col.create_index("status").unwrap();

    let results = col
        .find(Filter::In("status".into(), vec![s("active"), s("pending")]))
        .unwrap();
    assert_eq!(results.len(), 2);
}

#[test]
fn index_in_single_value_matches_one() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert(vec![("tag".into(), s("rust"))]).unwrap();
    col.insert(vec![("tag".into(), s("wasm"))]).unwrap();
    col.create_index("tag").unwrap();

    let results = col.find(Filter::In("tag".into(), vec![s("rust")])).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn index_in_no_match_returns_empty() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert(vec![("tag".into(), s("rust"))]).unwrap();
    col.create_index("tag").unwrap();

    let results = col
        .find(Filter::In("tag".into(), vec![s("java"), s("python")]))
        .unwrap();
    assert!(results.is_empty());
}

// ---------------------------------------------------------------------------
// String index sort order
// ---------------------------------------------------------------------------

#[test]
fn string_index_sorts_lexicographically() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("names");

    for name in ["charlie", "alice", "bob", "dave"] {
        col.insert(vec![("name".into(), s(name))]).unwrap();
    }
    col.create_index("name").unwrap();

    let results = col
        .find(Filter::And(vec![
            Filter::Gte("name".into(), s("alice")),
            Filter::Lte("name".into(), s("charlie")),
        ]))
        .unwrap();

    assert_eq!(results.len(), 3); // alice, bob, charlie
}

// ---------------------------------------------------------------------------
// Float index
// ---------------------------------------------------------------------------

#[test]
fn float_index_range() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("prices");

    for price in [1.99f64, 9.99, 19.99, 49.99, 99.99] {
        col.insert(vec![("price".into(), f(price))]).unwrap();
    }
    col.create_index("price").unwrap();

    let results = col.find(Filter::Lt("price".into(), f(20.0))).unwrap();
    assert_eq!(results.len(), 3);
}

// ---------------------------------------------------------------------------
// Index maintenance on writes
// ---------------------------------------------------------------------------

#[test]
fn index_maintained_on_update() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("email").unwrap();
    col.insert(vec![("email".into(), s("old@example.com"))])
        .unwrap();

    col.update_one(
        Filter::Eq("email".into(), s("old@example.com")),
        Update::Set(vec![("email".into(), s("new@example.com"))]),
    )
    .unwrap();

    let old = col
        .find(Filter::Eq("email".into(), s("old@example.com")))
        .unwrap();
    let new = col
        .find(Filter::Eq("email".into(), s("new@example.com")))
        .unwrap();

    assert_eq!(old.len(), 0, "old index entry must be removed");
    assert_eq!(new.len(), 1, "new index entry must exist");
}

#[test]
fn index_maintained_on_update_many() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("role").unwrap();
    for _ in 0..3 {
        col.insert(vec![("role".into(), s("trial"))]).unwrap();
    }

    col.update_many(
        Filter::Eq("role".into(), s("trial")),
        Update::Set(vec![("role".into(), s("user"))]),
    )
    .unwrap();

    assert_eq!(
        col.find(Filter::Eq("role".into(), s("trial")))
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        col.find(Filter::Eq("role".into(), s("user")))
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn index_maintained_on_delete() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("email").unwrap();
    col.insert(vec![("email".into(), s("alice@example.com"))])
        .unwrap();
    col.delete_one(Filter::Eq("email".into(), s("alice@example.com")))
        .unwrap();

    let results = col
        .find(Filter::Eq("email".into(), s("alice@example.com")))
        .unwrap();
    assert_eq!(
        results.len(),
        0,
        "stale index entry must be removed on delete"
    );
}

#[test]
fn index_maintained_on_delete_many() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("active").unwrap();
    col.insert(vec![("active".into(), b(true))]).unwrap();
    col.insert(vec![("active".into(), b(true))]).unwrap();
    col.insert(vec![("active".into(), b(false))]).unwrap();

    col.delete_many(Filter::Eq("active".into(), b(true)))
        .unwrap();

    // Index must not return deleted docs
    let results = col.find(Filter::Eq("active".into(), b(true))).unwrap();
    assert_eq!(results.len(), 0);
    // Remaining doc is findable
    let results = col.find(Filter::Eq("active".into(), b(false))).unwrap();
    assert_eq!(results.len(), 1);
}

// ---------------------------------------------------------------------------
// Backfill and lifecycle
// ---------------------------------------------------------------------------

#[test]
fn create_index_backfills_existing_docs() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("age".into(), i(30))]).unwrap();
    col.insert(vec![("age".into(), i(25))]).unwrap();

    // Create index after inserts — must backfill
    col.create_index("age").unwrap();

    let results = col.find(Filter::Gte("age".into(), i(28))).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("age").unwrap().as_int(), Some(30));
}

#[test]
fn create_index_is_idempotent() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("age".into(), i(30))]).unwrap();
    col.create_index("age").unwrap();
    col.create_index("age").unwrap(); // should not error or duplicate entries

    let results = col.find(Filter::Eq("age".into(), i(30))).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn drop_index_falls_back_to_full_scan() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("age".into(), i(30))]).unwrap();
    col.insert(vec![("age".into(), i(25))]).unwrap();
    col.create_index("age").unwrap();
    col.drop_index("age").unwrap();

    // After drop, query still works (full scan)
    let results = col.find(Filter::Gte("age".into(), i(28))).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn multiple_indexes_on_same_collection() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("email").unwrap();
    col.create_index("age").unwrap();
    col.create_index("role").unwrap();

    col.insert(vec![
        ("email".into(), s("alice@example.com")),
        ("age".into(), i(30)),
        ("role".into(), s("admin")),
    ])
    .unwrap();
    col.insert(vec![
        ("email".into(), s("bob@example.com")),
        ("age".into(), i(25)),
        ("role".into(), s("user")),
    ])
    .unwrap();

    assert_eq!(
        col.find(Filter::Eq("email".into(), s("alice@example.com")))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(col.find(Filter::Lt("age".into(), i(28))).unwrap().len(), 1);
    assert_eq!(
        col.find(Filter::Eq("role".into(), s("admin")))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn index_on_field_absent_in_some_docs() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("premium").unwrap();
    col.insert(vec![
        ("name".into(), s("Alice")),
        ("premium".into(), b(true)),
    ])
    .unwrap();
    col.insert(vec![("name".into(), s("Bob"))]).unwrap(); // no premium field
    col.insert(vec![
        ("name".into(), s("Carol")),
        ("premium".into(), b(false)),
    ])
    .unwrap();

    let results = col.find(Filter::Eq("premium".into(), b(true))).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("name"), Some(&s("Alice")));
}

// ---------------------------------------------------------------------------
// Or plan across indexed fields
// ---------------------------------------------------------------------------

#[test]
fn or_across_same_indexed_field() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("role").unwrap();
    for role in ["admin", "editor", "viewer", "banned"] {
        col.insert(vec![("role".into(), s(role))]).unwrap();
    }

    let results = col
        .find(Filter::Or(vec![
            Filter::Eq("role".into(), s("admin")),
            Filter::Eq("role".into(), s("editor")),
        ]))
        .unwrap();

    assert_eq!(results.len(), 2);
}

// ---------------------------------------------------------------------------
// $or across different indexed fields (v0.1.0 feature: IndexOr cross-field)
// ---------------------------------------------------------------------------

#[test]
fn or_across_different_indexed_fields() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("content");

    col.create_index("status").unwrap();
    col.create_index("priority").unwrap();

    col.insert(vec![
        ("status".into(), s("pinned")),
        ("priority".into(), i(0)),
    ])
    .unwrap();
    col.insert(vec![
        ("status".into(), s("normal")),
        ("priority".into(), i(1)),
    ])
    .unwrap();
    col.insert(vec![
        ("status".into(), s("normal")),
        ("priority".into(), i(0)),
    ])
    .unwrap();
    col.insert(vec![
        ("status".into(), s("archived")),
        ("priority".into(), i(0)),
    ])
    .unwrap();

    // status = 'pinned' OR priority = 1 — crosses two different indexed fields
    let results = col
        .find(Filter::Or(vec![
            Filter::Eq("status".into(), s("pinned")),
            Filter::Eq("priority".into(), i(1)),
        ]))
        .unwrap();

    assert_eq!(
        results.len(),
        2,
        "$or across different indexed fields must return 2 docs"
    );

    let statuses: Vec<&str> = results
        .iter()
        .map(|d| d.get("status").and_then(|v| v.as_str()).unwrap())
        .collect();
    assert!(
        statuses.contains(&"pinned"),
        "pinned doc must be in results"
    );
    assert!(
        statuses.contains(&"normal"),
        "priority=1 doc must be in results"
    );
}

// ---------------------------------------------------------------------------
// $nin with index excludes matched values
// ---------------------------------------------------------------------------

#[test]
fn nin_with_index_excludes_values() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.create_index("status").unwrap();
    for status in ["active", "pending", "deleted", "archived"] {
        col.insert(vec![("status".into(), s(status))]).unwrap();
    }

    // $nin on a field with an index should fall back to full-scan post-filter
    let results = col
        .find(Filter::Nin(
            "status".into(),
            vec![s("deleted"), s("archived")],
        ))
        .unwrap();

    assert_eq!(results.len(), 2);
    for doc in &results {
        let st = doc.get("status").and_then(|v| v.as_str()).unwrap();
        assert!(st == "active" || st == "pending", "unexpected status: {st}");
    }
}

// ---------------------------------------------------------------------------
// drop_index on nonexistent field returns error
// ---------------------------------------------------------------------------

#[test]
fn drop_index_on_nonexistent_returns_error() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    let err = col.drop_index("nonexistent_field").unwrap_err();
    assert!(
        format!("{err}").contains("not found"),
        "expected IndexNotFound error, got: {err}"
    );
}

// ---------------------------------------------------------------------------
// Large collection index performance (correctness, not timing)
// ---------------------------------------------------------------------------

#[test]
fn index_correct_on_large_collection() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("big");

    col.create_index("n").unwrap();
    for n in 0i64..200 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }

    let results = col
        .find(Filter::And(vec![
            Filter::Gte("n".into(), i(50)),
            Filter::Lt("n".into(), i(100)),
        ]))
        .unwrap();

    assert_eq!(results.len(), 50);
    for doc in &results {
        let n = doc.get("n").unwrap().as_int().unwrap();
        assert!(n >= 50 && n < 100);
    }
}
