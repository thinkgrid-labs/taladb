use zerodb_core::{Database, Filter, Value};

fn i(n: i64) -> Value { Value::Int(n) }
fn s(v: &str) -> Value { Value::Str(v.to_string()) }

#[test]
fn index_eq_lookup() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("email".into(), s("alice@example.com")), ("age".into(), i(30))]).unwrap();
    col.insert(vec![("email".into(), s("bob@example.com")),   ("age".into(), i(25))]).unwrap();

    col.create_index("email").unwrap();

    let results = col.find(Filter::Eq("email".into(), s("alice@example.com"))).unwrap();
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
        let p = doc.get("price").unwrap().as_int().unwrap();
        assert!(p >= 30);
    }
}

#[test]
fn index_in_lookup() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert(vec![("status".into(), s("active"))]).unwrap();
    col.insert(vec![("status".into(), s("pending"))]).unwrap();
    col.insert(vec![("status".into(), s("deleted"))]).unwrap();

    col.create_index("status").unwrap();

    let results = col.find(Filter::In(
        "status".into(),
        vec![s("active"), s("pending")],
    )).unwrap();
    assert_eq!(results.len(), 2);
}

#[test]
fn index_maintained_on_update() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("email").unwrap();
    col.insert(vec![("email".into(), s("old@example.com"))]).unwrap();

    col.update_one(
        Filter::Eq("email".into(), s("old@example.com")),
        zerodb_core::Update::Set(vec![("email".into(), s("new@example.com"))]),
    ).unwrap();

    let old = col.find(Filter::Eq("email".into(), s("old@example.com"))).unwrap();
    let new = col.find(Filter::Eq("email".into(), s("new@example.com"))).unwrap();
    assert_eq!(old.len(), 0, "old index entry should be removed");
    assert_eq!(new.len(), 1, "new index entry should exist");
}

#[test]
fn index_maintained_on_delete() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.create_index("email").unwrap();
    col.insert(vec![("email".into(), s("alice@example.com"))]).unwrap();
    col.delete_one(Filter::Eq("email".into(), s("alice@example.com"))).unwrap();

    let results = col.find(Filter::Eq("email".into(), s("alice@example.com"))).unwrap();
    assert_eq!(results.len(), 0, "index entry should be cleaned up on delete");
}

#[test]
fn create_index_backfills_existing_docs() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    // Insert before creating index
    col.insert(vec![("age".into(), i(30))]).unwrap();
    col.insert(vec![("age".into(), i(25))]).unwrap();

    // Create index after — should backfill
    col.create_index("age").unwrap();

    let results = col.find(Filter::Gte("age".into(), i(28))).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("age").unwrap().as_int(), Some(30));
}
