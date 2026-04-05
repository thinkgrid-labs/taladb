use taladb_core::{Database, Filter, Update, Value};

fn v(s: &str) -> Value {
    Value::Str(s.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}
fn b(x: bool) -> Value {
    Value::Bool(x)
}
fn f(x: f64) -> Value {
    Value::Float(x)
}

// ---------------------------------------------------------------------------
// Insert & find
// ---------------------------------------------------------------------------

#[test]
fn insert_and_find() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    let id = col
        .insert(vec![("name".into(), v("Alice")), ("age".into(), i(30))])
        .unwrap();

    let docs = col.find(Filter::All).unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].id, id);
    assert_eq!(docs[0].get("name"), Some(&v("Alice")));
}

#[test]
fn insert_many_and_count() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    let ids = col
        .insert_many(vec![
            vec![("x".into(), i(1))],
            vec![("x".into(), i(2))],
            vec![("x".into(), i(3))],
        ])
        .unwrap();

    assert_eq!(ids.len(), 3);
    assert_eq!(col.count(Filter::All).unwrap(), 3);
}

#[test]
fn insert_returns_unique_ids() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    let id1 = col.insert(vec![("v".into(), i(1))]).unwrap();
    let id2 = col.insert(vec![("v".into(), i(2))]).unwrap();
    let id3 = col.insert(vec![("v".into(), i(3))]).unwrap();

    assert_ne!(id1, id2);
    assert_ne!(id2, id3);
    assert_ne!(id1, id3);
}

#[test]
fn find_empty_collection_returns_empty_vec() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("empty");

    let docs = col.find(Filter::All).unwrap();
    assert!(docs.is_empty());
}

#[test]
fn find_one_returns_none_on_no_match() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice"))]).unwrap();

    let result = col.find_one(Filter::Eq("name".into(), v("Bob"))).unwrap();
    assert!(result.is_none());
}

#[test]
fn count_with_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("role".into(), v("admin"))]).unwrap();
    col.insert(vec![("role".into(), v("user"))]).unwrap();
    col.insert(vec![("role".into(), v("user"))]).unwrap();

    assert_eq!(col.count(Filter::Eq("role".into(), v("admin"))).unwrap(), 1);
    assert_eq!(col.count(Filter::Eq("role".into(), v("user"))).unwrap(), 2);
    assert_eq!(col.count(Filter::All).unwrap(), 3);
}

// ---------------------------------------------------------------------------
// Filter operators
// ---------------------------------------------------------------------------

#[test]
fn find_with_eq_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice")), ("age".into(), i(30))])
        .unwrap();
    col.insert(vec![("name".into(), v("Bob")), ("age".into(), i(25))])
        .unwrap();

    let results = col.find(Filter::Eq("name".into(), v("Alice"))).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("name"), Some(&v("Alice")));
}

#[test]
fn find_with_ne_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("status".into(), v("active"))]).unwrap();
    col.insert(vec![("status".into(), v("banned"))]).unwrap();
    col.insert(vec![("status".into(), v("active"))]).unwrap();

    let results = col.find(Filter::Ne("status".into(), v("banned"))).unwrap();
    assert_eq!(results.len(), 2);
}

#[test]
fn find_with_gt_and_lt() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("scores");

    for n in [10i64, 20, 30, 40, 50] {
        col.insert(vec![("score".into(), i(n))]).unwrap();
    }

    let gt = col.find(Filter::Gt("score".into(), i(30))).unwrap();
    assert_eq!(gt.len(), 2);

    let lt = col.find(Filter::Lt("score".into(), i(30))).unwrap();
    assert_eq!(lt.len(), 2);
}

#[test]
fn find_with_gte_lte_range() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("ages");

    for n in [18i64, 25, 30, 40, 65, 70] {
        col.insert(vec![("age".into(), i(n))]).unwrap();
    }

    let results = col
        .find(Filter::And(vec![
            Filter::Gte("age".into(), i(25)),
            Filter::Lte("age".into(), i(65)),
        ]))
        .unwrap();

    assert_eq!(results.len(), 4);
    for doc in &results {
        let age = doc.get("age").unwrap().as_int().unwrap();
        assert!((25..=65).contains(&age));
    }
}

#[test]
fn find_with_in_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    for role in ["admin", "editor", "viewer", "banned"] {
        col.insert(vec![("role".into(), v(role))]).unwrap();
    }

    let results = col
        .find(Filter::In("role".into(), vec![v("admin"), v("editor")]))
        .unwrap();

    assert_eq!(results.len(), 2);
}

#[test]
fn find_with_nin_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    for tag in ["rust", "wasm", "spam", "low-quality"] {
        col.insert(vec![("tag".into(), v(tag))]).unwrap();
    }

    let results = col
        .find(Filter::Nin("tag".into(), vec![v("spam"), v("low-quality")]))
        .unwrap();

    assert_eq!(results.len(), 2);
}

#[test]
fn find_with_exists_true_and_false() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("profiles");

    col.insert(vec![
        ("name".into(), v("Alice")),
        ("bio".into(), v("Rustacean")),
    ])
    .unwrap();
    col.insert(vec![("name".into(), v("Bob"))]).unwrap();
    col.insert(vec![
        ("name".into(), v("Carol")),
        ("bio".into(), v("Engineer")),
    ])
    .unwrap();

    let with_bio = col.find(Filter::Exists("bio".into(), true)).unwrap();
    assert_eq!(with_bio.len(), 2);

    let without_bio = col.find(Filter::Exists("bio".into(), false)).unwrap();
    assert_eq!(without_bio.len(), 1);
    assert_eq!(without_bio[0].get("name"), Some(&v("Bob")));
}

#[test]
fn find_with_and_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![
        ("role".into(), v("admin")),
        ("active".into(), b(true)),
    ])
    .unwrap();
    col.insert(vec![
        ("role".into(), v("admin")),
        ("active".into(), b(false)),
    ])
    .unwrap();
    col.insert(vec![("role".into(), v("user")), ("active".into(), b(true))])
        .unwrap();

    let results = col
        .find(Filter::And(vec![
            Filter::Eq("role".into(), v("admin")),
            Filter::Eq("active".into(), b(true)),
        ]))
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("role"), Some(&v("admin")));
    assert_eq!(results[0].get("active"), Some(&b(true)));
}

#[test]
fn find_with_or_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("events");

    for t in ["click", "scroll", "submit", "resize"] {
        col.insert(vec![("type".into(), v(t))]).unwrap();
    }

    let results = col
        .find(Filter::Or(vec![
            Filter::Eq("type".into(), v("click")),
            Filter::Eq("type".into(), v("submit")),
        ]))
        .unwrap();

    assert_eq!(results.len(), 2);
}

#[test]
fn find_with_not_filter() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("sessions");

    col.insert(vec![("expired".into(), b(false))]).unwrap();
    col.insert(vec![("expired".into(), b(true))]).unwrap();
    col.insert(vec![("expired".into(), b(false))]).unwrap();

    let results = col
        .find(Filter::Not(Box::new(Filter::Eq("expired".into(), b(true)))))
        .unwrap();

    assert_eq!(results.len(), 2);
}

#[test]
fn find_with_float_values() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("prices");

    col.insert(vec![("price".into(), f(9.99))]).unwrap();
    col.insert(vec![("price".into(), f(49.99))]).unwrap();
    col.insert(vec![("price".into(), f(99.99))]).unwrap();

    let cheap = col.find(Filter::Lt("price".into(), f(50.0))).unwrap();
    assert_eq!(cheap.len(), 2);
}

#[test]
fn find_with_bool_field() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("flags");

    col.insert(vec![("verified".into(), b(true))]).unwrap();
    col.insert(vec![("verified".into(), b(false))]).unwrap();

    assert_eq!(
        col.count(Filter::Eq("verified".into(), b(true))).unwrap(),
        1
    );
    assert_eq!(
        col.count(Filter::Eq("verified".into(), b(false))).unwrap(),
        1
    );
}

// ---------------------------------------------------------------------------
// Update operators
// ---------------------------------------------------------------------------

#[test]
fn update_one_set() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice")), ("age".into(), i(30))])
        .unwrap();

    let updated = col
        .update_one(
            Filter::Eq("name".into(), v("Alice")),
            Update::Set(vec![("age".into(), i(31))]),
        )
        .unwrap();
    assert!(updated);

    let doc = col
        .find_one(Filter::Eq("name".into(), v("Alice")))
        .unwrap()
        .unwrap();
    assert_eq!(doc.get("age"), Some(&i(31)));
}

#[test]
fn update_one_set_multiple_fields() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![
        ("name".into(), v("Alice")),
        ("age".into(), i(30)),
        ("role".into(), v("user")),
    ])
    .unwrap();

    col.update_one(
        Filter::Eq("name".into(), v("Alice")),
        Update::Set(vec![("age".into(), i(31)), ("role".into(), v("admin"))]),
    )
    .unwrap();

    let doc = col
        .find_one(Filter::Eq("name".into(), v("Alice")))
        .unwrap()
        .unwrap();
    assert_eq!(doc.get("age"), Some(&i(31)));
    assert_eq!(doc.get("role"), Some(&v("admin")));
}

#[test]
fn update_one_set_adds_new_field() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice"))]).unwrap();

    col.update_one(
        Filter::Eq("name".into(), v("Alice")),
        Update::Set(vec![("verified".into(), b(true))]),
    )
    .unwrap();

    let doc = col
        .find_one(Filter::Eq("name".into(), v("Alice")))
        .unwrap()
        .unwrap();
    assert_eq!(doc.get("verified"), Some(&b(true)));
}

#[test]
fn update_one_returns_false_when_no_match() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    let updated = col
        .update_one(
            Filter::Eq("name".into(), v("Nobody")),
            Update::Set(vec![("age".into(), i(99))]),
        )
        .unwrap();

    assert!(!updated);
}

#[test]
fn update_one_inc() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("counters");

    col.insert(vec![("count".into(), i(5))]).unwrap();
    col.update_one(Filter::All, Update::Inc(vec![("count".into(), i(3))]))
        .unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("count"), Some(&i(8)));
}

#[test]
fn update_one_inc_negative_decrements() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("counters");

    col.insert(vec![("stock".into(), i(10))]).unwrap();
    col.update_one(Filter::All, Update::Inc(vec![("stock".into(), i(-3))]))
        .unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("stock"), Some(&i(7)));
}

#[test]
fn update_one_unset_removes_field() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![
        ("name".into(), v("Alice")),
        ("temp_token".into(), v("abc123")),
    ])
    .unwrap();

    col.update_one(
        Filter::Eq("name".into(), v("Alice")),
        Update::Unset(vec!["temp_token".into()]),
    )
    .unwrap();

    let doc = col
        .find_one(Filter::Eq("name".into(), v("Alice")))
        .unwrap()
        .unwrap();
    assert!(doc.get("temp_token").is_none());
    assert_eq!(doc.get("name"), Some(&v("Alice"))); // other fields intact
}

#[test]
fn update_one_push_appends_to_array() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("posts");

    col.insert(vec![
        ("title".into(), v("Hello")),
        ("tags".into(), Value::Array(vec![v("rust")])),
    ])
    .unwrap();

    col.update_one(
        Filter::Eq("title".into(), v("Hello")),
        Update::Push("tags".into(), v("wasm")),
    )
    .unwrap();

    let doc = col
        .find_one(Filter::Eq("title".into(), v("Hello")))
        .unwrap()
        .unwrap();
    let tags = match doc.get("tags").unwrap() {
        Value::Array(arr) => arr.clone(),
        _ => panic!("expected array"),
    };
    assert_eq!(tags.len(), 2);
    assert!(tags.contains(&v("wasm")));
}

#[test]
fn update_one_pull_removes_from_array() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("posts");

    col.insert(vec![
        ("title".into(), v("Hello")),
        (
            "tags".into(),
            Value::Array(vec![v("rust"), v("spam"), v("wasm")]),
        ),
    ])
    .unwrap();

    col.update_one(
        Filter::Eq("title".into(), v("Hello")),
        Update::Pull("tags".into(), v("spam")),
    )
    .unwrap();

    let doc = col
        .find_one(Filter::Eq("title".into(), v("Hello")))
        .unwrap()
        .unwrap();
    let tags = match doc.get("tags").unwrap() {
        Value::Array(arr) => arr.clone(),
        _ => panic!("expected array"),
    };
    assert_eq!(tags.len(), 2);
    assert!(!tags.contains(&v("spam")));
}

#[test]
fn update_many_updates_all_matching() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    for _ in 0..3 {
        col.insert(vec![("role".into(), v("trial"))]).unwrap();
    }
    col.insert(vec![("role".into(), v("admin"))]).unwrap();

    let count = col
        .update_many(
            Filter::Eq("role".into(), v("trial")),
            Update::Set(vec![("role".into(), v("user"))]),
        )
        .unwrap();

    assert_eq!(count, 3);
    assert_eq!(col.count(Filter::Eq("role".into(), v("trial"))).unwrap(), 0);
    assert_eq!(col.count(Filter::Eq("role".into(), v("user"))).unwrap(), 3);
    assert_eq!(col.count(Filter::Eq("role".into(), v("admin"))).unwrap(), 1);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

#[test]
fn delete_one() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice"))]).unwrap();
    col.insert(vec![("name".into(), v("Bob"))]).unwrap();

    let deleted = col
        .delete_one(Filter::Eq("name".into(), v("Alice")))
        .unwrap();
    assert!(deleted);
    assert_eq!(col.count(Filter::All).unwrap(), 1);

    let remaining = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(remaining.get("name"), Some(&v("Bob")));
}

#[test]
fn delete_one_returns_false_when_no_match() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("users");

    col.insert(vec![("name".into(), v("Alice"))]).unwrap();

    let deleted = col
        .delete_one(Filter::Eq("name".into(), v("Nobody")))
        .unwrap();
    assert!(!deleted);
    assert_eq!(col.count(Filter::All).unwrap(), 1);
}

#[test]
fn delete_many() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert_many(vec![
        vec![("active".into(), b(true))],
        vec![("active".into(), b(true))],
        vec![("active".into(), b(false))],
    ])
    .unwrap();

    let count = col
        .delete_many(Filter::Eq("active".into(), b(true)))
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(col.count(Filter::All).unwrap(), 1);
}

#[test]
fn delete_many_all_deletes_entire_collection() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("logs");

    col.insert_many(vec![
        vec![("msg".into(), v("a"))],
        vec![("msg".into(), v("b"))],
        vec![("msg".into(), v("c"))],
    ])
    .unwrap();

    let count = col.delete_many(Filter::All).unwrap();
    assert_eq!(count, 3);
    assert_eq!(col.count(Filter::All).unwrap(), 0);
}

#[test]
fn delete_many_returns_zero_on_no_match() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items");

    col.insert(vec![("x".into(), i(1))]).unwrap();

    let count = col.delete_many(Filter::Eq("x".into(), i(999))).unwrap();
    assert_eq!(count, 0);
    assert_eq!(col.count(Filter::All).unwrap(), 1);
}

// ---------------------------------------------------------------------------
// Multiple collections are isolated
// ---------------------------------------------------------------------------

#[test]
fn collections_are_isolated() {
    let db = Database::open_in_memory().unwrap();

    let users = db.collection("users");
    let posts = db.collection("posts");

    users.insert(vec![("name".into(), v("Alice"))]).unwrap();
    posts
        .insert(vec![("title".into(), v("Hello World"))])
        .unwrap();

    assert_eq!(users.count(Filter::All).unwrap(), 1);
    assert_eq!(posts.count(Filter::All).unwrap(), 1);

    users.delete_many(Filter::All).unwrap();

    assert_eq!(users.count(Filter::All).unwrap(), 0);
    assert_eq!(posts.count(Filter::All).unwrap(), 1); // unaffected
}

// ---------------------------------------------------------------------------
// Value types round-trip through storage
// ---------------------------------------------------------------------------

#[test]
fn null_value_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs");

    col.insert(vec![("field".into(), Value::Null)]).unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("field"), Some(&Value::Null));
}

#[test]
fn nested_array_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs");

    let arr = Value::Array(vec![i(1), i(2), i(3)]);
    col.insert(vec![("nums".into(), arr.clone())]).unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("nums"), Some(&arr));
}

#[test]
fn bytes_value_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("docs");

    let raw = Value::Bytes(vec![0xDE, 0xAD, 0xBE, 0xEF]);
    col.insert(vec![("data".into(), raw.clone())]).unwrap();

    let doc = col.find_one(Filter::All).unwrap().unwrap();
    assert_eq!(doc.get("data"), Some(&raw));
}
