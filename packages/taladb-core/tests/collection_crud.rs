use taladb_core::{Database, Filter, Update, Value};

fn v(s: &str) -> Value { Value::Str(s.to_string()) }
fn i(n: i64) -> Value { Value::Int(n) }

#[test]
fn insert_and_find() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    let id = col.insert(vec![
        ("name".into(), v("Alice")),
        ("age".into(), i(30)),
    ]).unwrap();

    let docs = col.find(Filter::All).unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].id, id);
    assert_eq!(docs[0].get("name"), Some(&v("Alice")));
}

#[test]
fn find_with_eq_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice")), ("age".into(), i(30))]).unwrap();
    col.insert(vec![("name".into(), v("Bob")),   ("age".into(), i(25))]).unwrap();

    let results = col.find(Filter::Eq("name".into(), v("Alice"))).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("name"), Some(&v("Alice")));
}

#[test]
fn insert_many_and_count() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert_many(vec![
        vec![("x".into(), i(1))],
        vec![("x".into(), i(2))],
        vec![("x".into(), i(3))],
    ]).unwrap();

    assert_eq!(col.count(Filter::All).unwrap(), 3);
}

#[test]
fn update_one_set() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice")), ("age".into(), i(30))]).unwrap();

    let updated = col.update_one(
        Filter::Eq("name".into(), v("Alice")),
        Update::Set(vec![("age".into(), i(31))]),
    ).unwrap();
    assert!(updated);

    let doc = col.find_one(Filter::Eq("name".into(), v("Alice"))).unwrap().unwrap();
    assert_eq!(doc.get("age"), Some(&i(31)));
}

#[test]
fn update_one_inc() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert(vec![("count".into(), i(5))]).unwrap();

    col.update_one(Filter::All, Update::Inc(vec![("count".into(), i(3))])).unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("count"), Some(&i(8)));
}

#[test]
fn delete_one() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice"))]).unwrap();
    col.insert(vec![("name".into(), v("Bob"))]).unwrap();

    let deleted = col.delete_one(Filter::Eq("name".into(), v("Alice"))).unwrap();
    assert!(deleted);
    assert_eq!(col.count(Filter::All).unwrap(), 1);

    let remaining = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(remaining.get("name"), Some(&v("Bob")));
}

#[test]
fn delete_many() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert_many(vec![
        vec![("active".into(), Value::Bool(true))],
        vec![("active".into(), Value::Bool(true))],
        vec![("active".into(), Value::Bool(false))],
    ]).unwrap();

    let count = col.delete_many(Filter::Eq("active".into(), Value::Bool(true))).unwrap();
    assert_eq!(count, 2);
    assert_eq!(col.count(Filter::All).unwrap(), 1);
}
