use taladb_core::aggregate::{Accumulator, GroupKey, Stage};
use taladb_core::collection::Update;
use taladb_core::document::Value;
use taladb_core::query::options::{FindOptions, SortDirection, SortSpec};
use taladb_core::query::Filter;
use taladb_core::Database;

fn db() -> Database {
    Database::open_in_memory().unwrap()
}

// ---------------------------------------------------------------------------
// Nested field queries
// ---------------------------------------------------------------------------

#[test]
fn nested_field_eq() {
    let db = db();
    let col = db.collection("users");

    col.insert(vec![
        ("name".into(), Value::Str("Alice".into())),
        (
            "address".into(),
            Value::Object(vec![("city".into(), Value::Str("London".into()))]),
        ),
    ])
    .unwrap();
    col.insert(vec![
        ("name".into(), Value::Str("Bob".into())),
        (
            "address".into(),
            Value::Object(vec![("city".into(), Value::Str("Paris".into()))]),
        ),
    ])
    .unwrap();

    let results = col
        .find(Filter::Eq(
            "address.city".into(),
            Value::Str("London".into()),
        ))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("name"), Some(&Value::Str("Alice".into())));
}

#[test]
fn nested_field_three_levels() {
    let db = db();
    let col = db.collection("deep");

    col.insert(vec![(
        "a".into(),
        Value::Object(vec![(
            "b".into(),
            Value::Object(vec![("c".into(), Value::Int(42))]),
        )]),
    )])
    .unwrap();

    let results = col
        .find(Filter::Eq("a.b.c".into(), Value::Int(42)))
        .unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn nested_field_missing_returns_no_match() {
    let db = db();
    let col = db.collection("sparse_nested");

    // document without the nested field
    col.insert(vec![("name".into(), Value::Str("Charlie".into()))])
        .unwrap();

    let results = col
        .find(Filter::Eq(
            "address.city".into(),
            Value::Str("London".into()),
        ))
        .unwrap();
    assert!(results.is_empty());
}

#[test]
fn nested_field_non_object_parent_returns_no_match() {
    let db = db();
    let col = db.collection("non_obj");

    // "address" is a string, not an object — dot lookup should not panic
    col.insert(vec![
        ("address".into(), Value::Str("flat string".into())),
    ])
    .unwrap();

    let results = col
        .find(Filter::Eq(
            "address.city".into(),
            Value::Str("London".into()),
        ))
        .unwrap();
    assert!(results.is_empty());
}

#[test]
fn nested_field_range_filter() {
    let db = db();
    let col = db.collection("scores");

    for (name, score) in [("Alice", 80i64), ("Bob", 55), ("Carol", 92)] {
        col.insert(vec![
            ("name".into(), Value::Str(name.into())),
            (
                "meta".into(),
                Value::Object(vec![("score".into(), Value::Int(score))]),
            ),
        ])
        .unwrap();
    }

    let results = col
        .find(Filter::Gte("meta.score".into(), Value::Int(80)))
        .unwrap();
    let mut names: Vec<_> = results
        .iter()
        .map(|d| match d.get("name").unwrap() {
            Value::Str(s) => s.as_str(),
            _ => "",
        })
        .collect();
    names.sort_unstable();
    assert_eq!(names, vec!["Alice", "Carol"]);
}

#[test]
fn nested_field_exists_filter() {
    let db = db();
    let col = db.collection("exists_nested");

    col.insert(vec![(
        "meta".into(),
        Value::Object(vec![("score".into(), Value::Int(10))]),
    )])
    .unwrap();
    col.insert(vec![("other".into(), Value::Int(1))]).unwrap();

    let results = col
        .find(Filter::Exists("meta.score".into(), true))
        .unwrap();
    assert_eq!(results.len(), 1);

    let absent = col
        .find(Filter::Exists("meta.score".into(), false))
        .unwrap();
    assert_eq!(absent.len(), 1);
}

#[test]
fn nested_field_in_or_filter() {
    let db = db();
    let col = db.collection("or_nested");

    for (city, name) in [("London", "Alice"), ("Paris", "Bob"), ("Berlin", "Carol")] {
        col.insert(vec![
            ("name".into(), Value::Str(name.into())),
            (
                "address".into(),
                Value::Object(vec![("city".into(), Value::Str(city.into()))]),
            ),
        ])
        .unwrap();
    }

    let results = col
        .find(Filter::Or(vec![
            Filter::Eq("address.city".into(), Value::Str("London".into())),
            Filter::Eq("address.city".into(), Value::Str("Berlin".into())),
        ]))
        .unwrap();
    assert_eq!(results.len(), 2);
}

// ---------------------------------------------------------------------------
// $regex filter
// ---------------------------------------------------------------------------

#[test]
fn regex_filter_basic() {
    let db = db();
    let col = db.collection("emails");

    col.insert(vec![(
        "email".into(),
        Value::Str("alice@example.com".into()),
    )])
    .unwrap();
    col.insert(vec![("email".into(), Value::Str("bob@other.org".into()))])
        .unwrap();

    let results = col
        .find(Filter::Regex("email".into(), r"@example\.com$".into()))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].get("email"),
        Some(&Value::Str("alice@example.com".into()))
    );
}

#[test]
fn regex_no_match_returns_empty() {
    let db = db();
    let col = db.collection("items");
    col.insert(vec![("tag".into(), Value::Str("hello".into()))])
        .unwrap();

    let results = col
        .find(Filter::Regex("tag".into(), r"^xyz".into()))
        .unwrap();
    assert!(results.is_empty());
}

#[test]
fn regex_multiple_matches() {
    let db = db();
    let col = db.collection("urls");

    for url in ["http://a.com", "https://b.com", "ftp://c.net"] {
        col.insert(vec![("url".into(), Value::Str(url.into()))])
            .unwrap();
    }

    let results = col
        .find(Filter::Regex("url".into(), r"^https?://".into()))
        .unwrap();
    assert_eq!(results.len(), 2);
}

#[test]
fn regex_anchors_and_character_classes() {
    let db = db();
    let col = db.collection("greet");

    col.insert(vec![("code".into(), Value::Str("ABC-123".into()))]).unwrap();
    col.insert(vec![("code".into(), Value::Str("abc-456".into()))]).unwrap();
    col.insert(vec![("code".into(), Value::Str("ABC-XYZ".into()))]).unwrap();

    // Match codes that are uppercase letters followed by digits
    let results = col
        .find(Filter::Regex("code".into(), r"^[A-Z]+-\d+$".into()))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].get("code"),
        Some(&Value::Str("ABC-123".into()))
    );
}

#[test]
fn regex_on_non_string_field_returns_empty() {
    let db = db();
    let col = db.collection("nums_regex");

    col.insert(vec![("n".into(), Value::Int(42))]).unwrap();

    let results = col
        .find(Filter::Regex("n".into(), r"42".into()))
        .unwrap();
    assert!(results.is_empty());
}

#[test]
fn regex_invalid_pattern_does_not_panic() {
    let db = db();
    let col = db.collection("bad_regex");

    col.insert(vec![("s".into(), Value::Str("anything".into()))])
        .unwrap();

    // Invalid regex — `matches()` should return false gracefully, not panic
    let results = col
        .find(Filter::Regex("s".into(), r"[invalid".into()))
        .unwrap();
    assert!(results.is_empty());
}

#[test]
fn regex_combined_with_and_filter() {
    let db = db();
    let col = db.collection("combo_regex");

    for (name, tag) in [("Alice", "admin"), ("Bob", "admin"), ("Carol", "user")] {
        col.insert(vec![
            ("name".into(), Value::Str(name.into())),
            ("tag".into(), Value::Str(tag.into())),
        ])
        .unwrap();
    }

    let results = col
        .find(Filter::And(vec![
            Filter::Eq("tag".into(), Value::Str("admin".into())),
            Filter::Regex("name".into(), r"^A".into()),
        ]))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("name"), Some(&Value::Str("Alice".into())));
}

// ---------------------------------------------------------------------------
// Pagination / sort / projection
// ---------------------------------------------------------------------------

#[test]
fn find_with_options_sort_skip_limit() {
    let db = db();
    let col = db.collection("nums");

    for n in [5i64, 2, 8, 1, 9, 3] {
        col.insert(vec![("n".into(), Value::Int(n))]).unwrap();
    }

    let opts = FindOptions {
        sort: vec![SortSpec::asc("n")],
        skip: 1,
        limit: Some(3),
        fields: None,
    };
    let results = col.find_with_options(Filter::All, opts).unwrap();
    let ns: Vec<i64> = results
        .iter()
        .map(|d| match d.get("n").unwrap() {
            Value::Int(i) => *i,
            _ => panic!("expected int"),
        })
        .collect();
    // Sorted ascending: 1,2,3,5,8,9 → skip 1 → 2,3,5 → limit 3
    assert_eq!(ns, vec![2, 3, 5]);
}

#[test]
fn find_with_options_projection() {
    let db = db();
    let col = db.collection("proj");

    col.insert(vec![
        ("name".into(), Value::Str("Alice".into())),
        ("age".into(), Value::Int(30)),
        ("secret".into(), Value::Str("hidden".into())),
    ])
    .unwrap();

    let opts = FindOptions {
        sort: vec![],
        skip: 0,
        limit: None,
        fields: Some(vec!["name".into(), "age".into()]),
    };
    let results = col.find_with_options(Filter::All, opts).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].get("name").is_some());
    assert!(results[0].get("age").is_some());
    assert!(results[0].get("secret").is_none());
}

#[test]
fn sort_descending() {
    let db = db();
    let col = db.collection("desc");

    for n in [1i64, 5, 3] {
        col.insert(vec![("v".into(), Value::Int(n))]).unwrap();
    }

    let opts = FindOptions {
        sort: vec![SortSpec {
            field: "v".into(),
            direction: SortDirection::Desc,
        }],
        skip: 0,
        limit: None,
        fields: None,
    };
    let results = col.find_with_options(Filter::All, opts).unwrap();
    let vs: Vec<i64> = results
        .iter()
        .map(|d| match d.get("v").unwrap() {
            Value::Int(i) => *i,
            _ => panic!(),
        })
        .collect();
    assert_eq!(vs, vec![5, 3, 1]);
}

#[test]
fn multi_field_sort() {
    let db = db();
    let col = db.collection("multi_sort");

    for (dept, salary) in [("eng", 80i64), ("hr", 60), ("eng", 70), ("hr", 90)] {
        col.insert(vec![
            ("dept".into(), Value::Str(dept.into())),
            ("salary".into(), Value::Int(salary)),
        ])
        .unwrap();
    }

    let opts = FindOptions {
        sort: vec![SortSpec::asc("dept"), SortSpec::desc("salary")],
        skip: 0,
        limit: None,
        fields: None,
    };
    let results = col.find_with_options(Filter::All, opts).unwrap();
    let pairs: Vec<(&str, i64)> = results
        .iter()
        .map(|d| {
            let dept = match d.get("dept").unwrap() {
                Value::Str(s) => s.as_str(),
                _ => "",
            };
            let sal = match d.get("salary").unwrap() {
                Value::Int(n) => *n,
                _ => 0,
            };
            (dept, sal)
        })
        .collect();
    // dept asc → eng (80,70 desc), hr (90,60 desc)
    assert_eq!(pairs, vec![("eng", 80), ("eng", 70), ("hr", 90), ("hr", 60)]);
}

#[test]
fn skip_beyond_collection_size_returns_empty() {
    let db = db();
    let col = db.collection("skip_overflow");

    for n in 1i64..=3 {
        col.insert(vec![("n".into(), Value::Int(n))]).unwrap();
    }

    let opts = FindOptions {
        sort: vec![],
        skip: 100,
        limit: None,
        fields: None,
    };
    assert!(col.find_with_options(Filter::All, opts).unwrap().is_empty());
}

#[test]
fn limit_zero_returns_empty() {
    let db = db();
    let col = db.collection("limit_zero");

    col.insert(vec![("x".into(), Value::Int(1))]).unwrap();

    let opts = FindOptions {
        sort: vec![],
        skip: 0,
        limit: Some(0),
        fields: None,
    };
    assert!(col.find_with_options(Filter::All, opts).unwrap().is_empty());
}

#[test]
fn pagination_with_filter() {
    let db = db();
    let col = db.collection("page_filter");

    col.create_index("status").unwrap();
    for i in 1i64..=10 {
        col.insert(vec![
            ("n".into(), Value::Int(i)),
            ("status".into(), Value::Str("active".into())),
        ])
        .unwrap();
    }
    col.insert(vec![
        ("n".into(), Value::Int(99)),
        ("status".into(), Value::Str("inactive".into())),
    ])
    .unwrap();

    let opts = FindOptions {
        sort: vec![SortSpec::asc("n")],
        skip: 3,
        limit: Some(4),
        fields: None,
    };
    let results = col
        .find_with_options(Filter::Eq("status".into(), Value::Str("active".into())), opts)
        .unwrap();
    let ns: Vec<i64> = results
        .iter()
        .map(|d| match d.get("n").unwrap() {
            Value::Int(i) => *i,
            _ => panic!(),
        })
        .collect();
    // active sorted: 1..10, skip 3 → 4,5,6,7 (limit 4)
    assert_eq!(ns, vec![4, 5, 6, 7]);
}

// ---------------------------------------------------------------------------
// Compound indexes
// ---------------------------------------------------------------------------

#[test]
fn compound_index_eq_lookup() {
    let db = db();
    let col = db.collection("people");

    col.create_compound_index(&["last", "first"]).unwrap();

    col.insert(vec![
        ("last".into(), Value::Str("Smith".into())),
        ("first".into(), Value::Str("Alice".into())),
    ])
    .unwrap();
    col.insert(vec![
        ("last".into(), Value::Str("Smith".into())),
        ("first".into(), Value::Str("Bob".into())),
    ])
    .unwrap();
    col.insert(vec![
        ("last".into(), Value::Str("Jones".into())),
        ("first".into(), Value::Str("Alice".into())),
    ])
    .unwrap();

    let results = col
        .find(Filter::And(vec![
            Filter::Eq("last".into(), Value::Str("Smith".into())),
            Filter::Eq("first".into(), Value::Str("Alice".into())),
        ]))
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("first"), Some(&Value::Str("Alice".into())));
    assert_eq!(results[0].get("last"), Some(&Value::Str("Smith".into())));
}

#[test]
fn compound_index_survives_delete() {
    let db = db();
    let col = db.collection("ci_del");

    col.create_compound_index(&["a", "b"]).unwrap();

    let id = col
        .insert(vec![
            ("a".into(), Value::Str("x".into())),
            ("b".into(), Value::Str("y".into())),
        ])
        .unwrap();

    col.delete_by_id(id).unwrap();

    let results = col
        .find(Filter::And(vec![
            Filter::Eq("a".into(), Value::Str("x".into())),
            Filter::Eq("b".into(), Value::Str("y".into())),
        ]))
        .unwrap();
    assert!(results.is_empty());
}

#[test]
fn compound_index_backfills_existing_docs() {
    let db = db();
    let col = db.collection("ci_backfill");

    // Insert before index exists
    col.insert(vec![
        ("x".into(), Value::Str("foo".into())),
        ("y".into(), Value::Str("bar".into())),
    ])
    .unwrap();

    col.create_compound_index(&["x", "y"]).unwrap();

    let results = col
        .find(Filter::And(vec![
            Filter::Eq("x".into(), Value::Str("foo".into())),
            Filter::Eq("y".into(), Value::Str("bar".into())),
        ]))
        .unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn compound_index_maintained_on_update() {
    let db = db();
    let col = db.collection("ci_update");

    col.create_compound_index(&["a", "b"]).unwrap();

    col.insert(vec![
        ("a".into(), Value::Str("old".into())),
        ("b".into(), Value::Str("val".into())),
    ])
    .unwrap();

    col.update_one(
        Filter::Eq("a".into(), Value::Str("old".into())),
        Update::Set(vec![("a".into(), Value::Str("new".into()))]),
    )
    .unwrap();

    // old key is gone
    let old = col
        .find(Filter::And(vec![
            Filter::Eq("a".into(), Value::Str("old".into())),
            Filter::Eq("b".into(), Value::Str("val".into())),
        ]))
        .unwrap();
    assert!(old.is_empty());

    // new key is present
    let new = col
        .find(Filter::And(vec![
            Filter::Eq("a".into(), Value::Str("new".into())),
            Filter::Eq("b".into(), Value::Str("val".into())),
        ]))
        .unwrap();
    assert_eq!(new.len(), 1);
}

#[test]
fn compound_index_maintained_on_delete_many() {
    let db = db();
    let col = db.collection("ci_delmany");

    col.create_compound_index(&["cat", "item"]).unwrap();

    for (cat, item) in [("food", "apple"), ("food", "banana"), ("tech", "laptop")] {
        col.insert(vec![
            ("cat".into(), Value::Str(cat.into())),
            ("item".into(), Value::Str(item.into())),
        ])
        .unwrap();
    }

    col.delete_many(Filter::Eq("cat".into(), Value::Str("food".into())))
        .unwrap();

    let food = col
        .find(Filter::Eq("cat".into(), Value::Str("food".into())))
        .unwrap();
    assert!(food.is_empty());

    let tech = col
        .find(Filter::And(vec![
            Filter::Eq("cat".into(), Value::Str("tech".into())),
            Filter::Eq("item".into(), Value::Str("laptop".into())),
        ]))
        .unwrap();
    assert_eq!(tech.len(), 1);
}

#[test]
fn drop_compound_index_falls_back_to_full_scan() {
    let db = db();
    let col = db.collection("ci_drop");

    col.create_compound_index(&["p", "q"]).unwrap();

    col.insert(vec![
        ("p".into(), Value::Str("alpha".into())),
        ("q".into(), Value::Str("beta".into())),
    ])
    .unwrap();

    col.drop_compound_index(&["p", "q"]).unwrap();

    // Query still works via full scan
    let results = col
        .find(Filter::And(vec![
            Filter::Eq("p".into(), Value::Str("alpha".into())),
            Filter::Eq("q".into(), Value::Str("beta".into())),
        ]))
        .unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn drop_nonexistent_compound_index_returns_error() {
    let db = db();
    let col = db.collection("ci_no_drop");

    let err = col.drop_compound_index(&["x", "y"]);
    assert!(err.is_err());
}

#[test]
fn compound_index_idempotent_create() {
    let db = db();
    let col = db.collection("ci_idem");

    col.create_compound_index(&["m", "n"]).unwrap();
    // Second call is a no-op, not an error
    col.create_compound_index(&["m", "n"]).unwrap();
}

#[test]
fn compound_index_with_int_fields() {
    let db = db();
    let col = db.collection("ci_ints");

    col.create_compound_index(&["year", "month"]).unwrap();

    for (y, m) in [(2024i64, 1i64), (2024, 6), (2025, 1)] {
        col.insert(vec![
            ("year".into(), Value::Int(y)),
            ("month".into(), Value::Int(m)),
        ])
        .unwrap();
    }

    let results = col
        .find(Filter::And(vec![
            Filter::Eq("year".into(), Value::Int(2024)),
            Filter::Eq("month".into(), Value::Int(6)),
        ]))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("month"), Some(&Value::Int(6)));
}

#[test]
fn compound_index_doc_missing_field_not_indexed() {
    let db = db();
    let col = db.collection("ci_sparse");

    col.create_compound_index(&["a", "b"]).unwrap();

    // This doc is missing field "b" — should not be in the index
    col.insert(vec![("a".into(), Value::Str("only_a".into()))]).unwrap();

    // The doc should still be findable via full scan on field "a"
    let results = col
        .find(Filter::Eq("a".into(), Value::Str("only_a".into())))
        .unwrap();
    assert_eq!(results.len(), 1);

    // But an And on both fields should find nothing
    let results2 = col
        .find(Filter::And(vec![
            Filter::Eq("a".into(), Value::Str("only_a".into())),
            Filter::Eq("b".into(), Value::Str("anything".into())),
        ]))
        .unwrap();
    assert!(results2.is_empty());
}

#[test]
fn multiple_compound_indexes_on_same_collection() {
    let db = db();
    let col = db.collection("ci_multi");

    col.create_compound_index(&["x", "y"]).unwrap();
    col.create_compound_index(&["y", "z"]).unwrap();

    col.insert(vec![
        ("x".into(), Value::Int(1)),
        ("y".into(), Value::Int(2)),
        ("z".into(), Value::Int(3)),
    ])
    .unwrap();

    let r1 = col
        .find(Filter::And(vec![
            Filter::Eq("x".into(), Value::Int(1)),
            Filter::Eq("y".into(), Value::Int(2)),
        ]))
        .unwrap();
    assert_eq!(r1.len(), 1);

    let r2 = col
        .find(Filter::And(vec![
            Filter::Eq("y".into(), Value::Int(2)),
            Filter::Eq("z".into(), Value::Int(3)),
        ]))
        .unwrap();
    assert_eq!(r2.len(), 1);
}

// ---------------------------------------------------------------------------
// Aggregation pipeline
// ---------------------------------------------------------------------------

#[test]
fn aggregate_group_sum_count() {
    let db = db();
    let col = db.collection("sales");

    for (dept, amount) in [
        ("eng", 100i64),
        ("eng", 200),
        ("hr", 50),
        ("hr", 75),
        ("hr", 25),
    ] {
        col.insert(vec![
            ("dept".into(), Value::Str(dept.into())),
            ("amount".into(), Value::Int(amount)),
        ])
        .unwrap();
    }

    let results = col
        .aggregate(vec![
            Stage::Group {
                key: GroupKey::Field("dept".into()),
                accumulators: vec![
                    ("total".into(), Accumulator::Sum("amount".into())),
                    ("n".into(), Accumulator::Count),
                ],
            },
            Stage::Sort(vec![SortSpec::asc("_id")]),
        ])
        .unwrap();

    assert_eq!(results.len(), 2);

    let eng = &results[0];
    assert_eq!(eng.get("_id"), Some(&Value::Str("eng".into())));
    assert_eq!(eng.get("total"), Some(&Value::Int(300)));
    assert_eq!(eng.get("n"), Some(&Value::Int(2)));

    let hr = &results[1];
    assert_eq!(hr.get("_id"), Some(&Value::Str("hr".into())));
    assert_eq!(hr.get("total"), Some(&Value::Int(150)));
    assert_eq!(hr.get("n"), Some(&Value::Int(3)));
}

#[test]
fn aggregate_match_then_group() {
    let db = db();
    let col = db.collection("orders");

    for (status, val) in [("open", 10i64), ("open", 20), ("closed", 5), ("open", 30)] {
        col.insert(vec![
            ("status".into(), Value::Str(status.into())),
            ("val".into(), Value::Int(val)),
        ])
        .unwrap();
    }

    let results = col
        .aggregate(vec![
            Stage::Match(Filter::Eq("status".into(), Value::Str("open".into()))),
            Stage::Group {
                key: GroupKey::Null,
                accumulators: vec![("total".into(), Accumulator::Sum("val".into()))],
            },
        ])
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("total"), Some(&Value::Int(60)));
}

#[test]
fn aggregate_project_stage() {
    let db = db();
    let col = db.collection("proj_agg");

    col.insert(vec![
        ("name".into(), Value::Str("Alice".into())),
        ("score".into(), Value::Int(95)),
        ("secret".into(), Value::Int(42)),
    ])
    .unwrap();

    let results = col
        .aggregate(vec![Stage::Project(vec!["name".into(), "score".into()])])
        .unwrap();

    assert_eq!(results.len(), 1);
    assert!(results[0].get("name").is_some());
    assert!(results[0].get("score").is_some());
    assert!(results[0].get("secret").is_none());
}

#[test]
fn aggregate_sort_skip_limit() {
    let db = db();
    let col = db.collection("pipeline_ops");

    for n in 1i64..=10 {
        col.insert(vec![("n".into(), Value::Int(n))]).unwrap();
    }

    let results = col
        .aggregate(vec![
            Stage::Sort(vec![SortSpec::desc("n")]),
            Stage::Skip(2),
            Stage::Limit(3),
        ])
        .unwrap();

    // sorted desc: 10,9,8,7,6,5,4,3,2,1 → skip 2 → 8,7,6,5,4,3,2,1 → limit 3 → 8,7,6
    let ns: Vec<i64> = results
        .iter()
        .map(|d| match d.get("n").unwrap() {
            Value::Int(i) => *i,
            _ => panic!(),
        })
        .collect();
    assert_eq!(ns, vec![8, 7, 6]);
}

#[test]
fn aggregate_avg_min_max() {
    let db = db();
    let col = db.collection("stats");

    for n in [10i64, 20, 30] {
        col.insert(vec![("v".into(), Value::Int(n))]).unwrap();
    }

    let results = col
        .aggregate(vec![Stage::Group {
            key: GroupKey::Null,
            accumulators: vec![
                ("avg".into(), Accumulator::Avg("v".into())),
                ("mn".into(), Accumulator::Min("v".into())),
                ("mx".into(), Accumulator::Max("v".into())),
            ],
        }])
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("avg"), Some(&Value::Float(20.0)));
    assert_eq!(results[0].get("mn"), Some(&Value::Int(10)));
    assert_eq!(results[0].get("mx"), Some(&Value::Int(30)));
}

#[test]
fn aggregate_push_accumulator() {
    let db = db();
    let col = db.collection("push_acc");

    for tag in ["a", "b", "c"] {
        col.insert(vec![("tag".into(), Value::Str(tag.into()))])
            .unwrap();
    }

    let results = col
        .aggregate(vec![Stage::Group {
            key: GroupKey::Null,
            accumulators: vec![("tags".into(), Accumulator::Push("tag".into()))],
        }])
        .unwrap();

    assert_eq!(results.len(), 1);
    match results[0].get("tags").unwrap() {
        Value::Array(arr) => assert_eq!(arr.len(), 3),
        _ => panic!("expected array"),
    }
}

#[test]
fn aggregate_add_to_set_deduplicates() {
    let db = db();
    let col = db.collection("set_acc");

    for color in ["red", "blue", "red", "green", "blue"] {
        col.insert(vec![("color".into(), Value::Str(color.into()))])
            .unwrap();
    }

    let results = col
        .aggregate(vec![Stage::Group {
            key: GroupKey::Null,
            accumulators: vec![("colors".into(), Accumulator::AddToSet("color".into()))],
        }])
        .unwrap();

    assert_eq!(results.len(), 1);
    match results[0].get("colors").unwrap() {
        Value::Array(arr) => assert_eq!(arr.len(), 3), // red, blue, green
        _ => panic!("expected array"),
    }
}

#[test]
fn aggregate_first_and_last() {
    let db = db();
    let col = db.collection("first_last");

    // Insert in order — ULID ensures insertion order is preserved on full scan
    for n in [10i64, 20, 30] {
        col.insert(vec![("v".into(), Value::Int(n))]).unwrap();
    }

    let results = col
        .aggregate(vec![
            Stage::Sort(vec![SortSpec::asc("v")]),
            Stage::Group {
                key: GroupKey::Null,
                accumulators: vec![
                    ("first".into(), Accumulator::First("v".into())),
                    ("last".into(), Accumulator::Last("v".into())),
                ],
            },
        ])
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("first"), Some(&Value::Int(10)));
    assert_eq!(results[0].get("last"), Some(&Value::Int(30)));
}

#[test]
fn aggregate_group_null_key_for_missing_field() {
    let db = db();
    let col = db.collection("null_key");

    col.insert(vec![("v".into(), Value::Int(1))]).unwrap(); // no "cat" field
    col.insert(vec![
        ("cat".into(), Value::Str("a".into())),
        ("v".into(), Value::Int(2)),
    ])
    .unwrap();

    let results = col
        .aggregate(vec![Stage::Group {
            key: GroupKey::Field("cat".into()),
            accumulators: vec![("total".into(), Accumulator::Sum("v".into()))],
        }])
        .unwrap();

    // Two groups: null (v=1) and "a" (v=2)
    assert_eq!(results.len(), 2);
}

#[test]
fn aggregate_on_empty_collection_returns_empty() {
    let db = db();
    let col = db.collection("empty_agg");

    let results = col
        .aggregate(vec![Stage::Group {
            key: GroupKey::Null,
            accumulators: vec![("total".into(), Accumulator::Sum("v".into()))],
        }])
        .unwrap();

    assert!(results.is_empty());
}

#[test]
fn aggregate_avg_no_numeric_values_returns_null() {
    let db = db();
    let col = db.collection("avg_null");

    // Field "v" is a string — avg should return Null
    col.insert(vec![("v".into(), Value::Str("text".into()))])
        .unwrap();

    let results = col
        .aggregate(vec![Stage::Group {
            key: GroupKey::Null,
            accumulators: vec![("avg".into(), Accumulator::Avg("v".into()))],
        }])
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("avg"), Some(&Value::Null));
}

#[test]
fn aggregate_match_uses_secondary_index() {
    let db = db();
    let col = db.collection("agg_idx");

    col.create_index("status").unwrap();

    for i in 1i64..=5 {
        col.insert(vec![
            ("status".into(), Value::Str("active".into())),
            ("n".into(), Value::Int(i)),
        ])
        .unwrap();
    }
    col.insert(vec![
        ("status".into(), Value::Str("inactive".into())),
        ("n".into(), Value::Int(99)),
    ])
    .unwrap();

    let results = col
        .aggregate(vec![
            Stage::Match(Filter::Eq(
                "status".into(),
                Value::Str("active".into()),
            )),
            Stage::Group {
                key: GroupKey::Null,
                accumulators: vec![("total".into(), Accumulator::Sum("n".into()))],
            },
        ])
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("total"), Some(&Value::Int(15))); // 1+2+3+4+5
}

#[test]
fn aggregate_full_pipeline() {
    let db = db();
    let col = db.collection("full_pipeline");

    for (region, product, revenue) in [
        ("eu", "widget", 100i64),
        ("eu", "gadget", 200),
        ("eu", "widget", 150),
        ("us", "widget", 300),
        ("us", "gadget", 50),
        ("us", "widget", 250),
    ] {
        col.insert(vec![
            ("region".into(), Value::Str(region.into())),
            ("product".into(), Value::Str(product.into())),
            ("revenue".into(), Value::Int(revenue)),
        ])
        .unwrap();
    }

    // Only EU, group by product, sort by total desc, take top-1, project name+total
    let results = col
        .aggregate(vec![
            Stage::Match(Filter::Eq("region".into(), Value::Str("eu".into()))),
            Stage::Group {
                key: GroupKey::Field("product".into()),
                accumulators: vec![("total".into(), Accumulator::Sum("revenue".into()))],
            },
            Stage::Sort(vec![SortSpec::desc("total")]),
            Stage::Limit(1),
            Stage::Project(vec!["_id".into(), "total".into()]),
        ])
        .unwrap();

    assert_eq!(results.len(), 1);
    // EU widget: 100+150=250, EU gadget: 200 → top is widget
    assert_eq!(results[0].get("_id"), Some(&Value::Str("widget".into())));
    assert_eq!(results[0].get("total"), Some(&Value::Int(250)));
}

#[test]
fn aggregate_group_by_nested_field() {
    let db = db();
    let col = db.collection("nested_group");

    for (country, n) in [("uk", 10i64), ("uk", 20), ("fr", 5)] {
        col.insert(vec![
            (
                "location".into(),
                Value::Object(vec![("country".into(), Value::Str(country.into()))]),
            ),
            ("n".into(), Value::Int(n)),
        ])
        .unwrap();
    }

    // $group on a nested key (via Match+Group — Match narrows, Group uses top-level eq)
    // Verify nested field filtering works before group
    let results = col
        .aggregate(vec![
            Stage::Match(Filter::Eq(
                "location.country".into(),
                Value::Str("uk".into()),
            )),
            Stage::Group {
                key: GroupKey::Null,
                accumulators: vec![("total".into(), Accumulator::Sum("n".into()))],
            },
        ])
        .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("total"), Some(&Value::Int(30)));
}
