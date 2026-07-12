//! `$project` inclusion/exclusion semantics, and the bounded (top-K) `$sort`.
use taladb_core::Database;
use taladb_core::aggregate::{Stage, parse_pipeline};
use taladb_core::document::{Document, Value};
use taladb_core::query::Filter;
use taladb_core::query::options::{SortDirection, SortSpec};
use serde_json::json;

fn parse(src: serde_json::Value) -> Result<Vec<Stage>, String> {
    parse_pipeline(&src, &|_| Ok(Filter::All))
}

fn db_with(n: usize) -> Database {
    let db = Database::open_in_memory().unwrap();
    let col = db.collection("items").unwrap();
    for i in 0..n {
        col.insert(vec![
            ("name".into(), Value::Str(format!("item-{i:04}"))),
            ("score".into(), Value::Int((i % 10) as i64)), // heavy ties on purpose
            ("bulky".into(), Value::Str("x".repeat(64))),
        ])
        .unwrap();
    }
    db
}

fn names(docs: &[Document]) -> Vec<String> {
    docs.iter()
        .map(|d| match d.get("name") {
            Some(Value::Str(s)) => s.clone(),
            _ => "<none>".into(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// $project
// ---------------------------------------------------------------------------

#[test]
fn project_exclusion_keeps_every_other_field() {
    let db = db_with(3);
    let col = db.collection("items").unwrap();

    let out = col
        .aggregate(parse(json!([{ "$project": { "bulky": 0 } }])).unwrap())
        .unwrap();

    assert_eq!(out.len(), 3);
    for d in &out {
        // The excluded field is gone...
        assert!(d.get("bulky").is_none(), "excluded field survived");
        // ...and everything else is still here. Before this fix an exclusion
        // parsed to an empty *inclusion*, silently returning `_id`-only docs.
        assert!(d.get("name").is_some(), "unlisted field was dropped");
        assert!(d.get("score").is_some(), "unlisted field was dropped");
    }
}

#[test]
fn project_inclusion_keeps_only_listed_fields() {
    let db = db_with(2);
    let col = db.collection("items").unwrap();

    let out = col
        .aggregate(parse(json!([{ "$project": { "name": 1 } }])).unwrap())
        .unwrap();

    for d in &out {
        assert!(d.get("name").is_some());
        assert!(d.get("score").is_none());
        assert!(d.get("bulky").is_none());
    }
}

#[test]
fn project_rejects_mixed_inclusion_and_exclusion() {
    let err = parse(json!([{ "$project": { "name": 1, "bulky": 0 } }])).unwrap_err();
    assert!(err.contains("cannot mix"), "unexpected error: {err}");
}

#[test]
fn project_allows_id_exclusion_alongside_inclusion() {
    // `{a: 1, _id: 0}` stays a pure inclusion — the one permitted mix.
    let pl = parse(json!([{ "$project": { "name": 1, "_id": 0 } }])).unwrap();
    assert!(matches!(
        &pl[0],
        Stage::Project { fields, include: true, keep_id: false } if fields == &vec!["name".to_string()]
    ));
}

#[test]
fn project_rejects_empty_body() {
    assert!(parse(json!([{ "$project": {} }])).is_err());
}

/// Values are read for truthiness the way MongoDB reads them: zero excludes,
/// every other number includes. The truthiness test runs on the number itself —
/// casting to `i64` first would floor `0.5` to `0` and silently turn an
/// inclusion into an exclusion.
#[test]
fn project_reads_nonzero_numbers_as_inclusion() {
    for spec in [
        json!(1),
        json!(2),
        json!(1.5),
        json!(0.5),
        json!(-1),
        json!(true),
    ] {
        let pl = parse(json!([{ "$project": { "name": spec } }])).unwrap();
        assert!(
            matches!(&pl[0], Stage::Project { fields, include: true, .. } if fields == &vec!["name".to_string()]),
            "{spec} should include, got {:?}",
            pl[0],
        );
    }
}

#[test]
fn project_reads_zero_as_exclusion() {
    for spec in [json!(0), json!(0.0), json!(-0.0), json!(false)] {
        let pl = parse(json!([{ "$project": { "bulky": spec } }])).unwrap();
        assert!(
            matches!(&pl[0], Stage::Project { fields, include: false, .. } if fields == &vec!["bulky".to_string()]),
            "{spec} should exclude, got {:?}",
            pl[0],
        );
    }
}

/// `{a: 0.5, b: 1}` names no exclusion, so it must not trip the mixing check.
/// Under an `i64` cast `0.5` floored to `0` and this errored out.
#[test]
fn project_fractional_inclusion_is_not_mistaken_for_mixing() {
    let pl = parse(json!([{ "$project": { "name": 0.5, "score": 1 } }])).unwrap();
    assert!(matches!(&pl[0], Stage::Project { include: true, .. }));

    let out = db_with(3)
        .collection("items")
        .unwrap()
        .aggregate(pl)
        .unwrap();
    for d in &out {
        assert!(
            d.get("name").is_some(),
            "fractional-truthy field was dropped"
        );
        assert!(d.get("score").is_some());
        assert!(
            d.get("bulky").is_none(),
            "unlisted field survived an inclusion"
        );
    }
}

#[test]
fn project_rejects_non_numeric_non_boolean_values() {
    let err = parse(json!([{ "$project": { "name": "yes" } }])).unwrap_err();
    assert!(
        err.contains("must be a number or boolean"),
        "unexpected: {err}"
    );
}

// ---------------------------------------------------------------------------
// Bounded ($sort + $skip + $limit) — must be indistinguishable from a full sort
// ---------------------------------------------------------------------------

fn sort_desc_score() -> Vec<SortSpec> {
    vec![SortSpec {
        field: "score".into(),
        direction: SortDirection::Desc,
    }]
}

#[test]
fn bounded_sort_matches_full_sort() {
    let db = db_with(500);
    let col = db.collection("items").unwrap();

    // Ground truth: sort everything, then slice in the caller.
    let full = col
        .aggregate(vec![Stage::Sort(sort_desc_score())])
        .unwrap();
    assert_eq!(full.len(), 500);

    // Bounded: the engine gets to stop early.
    let page = col
        .aggregate(vec![
            Stage::Sort(sort_desc_score()),
            Stage::Skip(0),
            Stage::Limit(24),
        ])
        .unwrap();

    assert_eq!(names(&page), names(&full[0..24]));
}

#[test]
fn bounded_sort_pages_do_not_overlap_or_drop() {
    // The property that forced the `_id` tiebreak: `score` has only 10 distinct
    // values across 500 docs, so ties are everywhere. If tied documents were
    // ordered arbitrarily per call, growing `keep` per page would let a document
    // appear on two pages — or on none.
    let db = db_with(500);
    let col = db.collection("items").unwrap();

    let full = col.aggregate(vec![Stage::Sort(sort_desc_score())]).unwrap();

    let mut paged: Vec<String> = Vec::new();
    for page in 0..10 {
        let out = col
            .aggregate(vec![
                Stage::Sort(sort_desc_score()),
                Stage::Skip(page * 24),
                Stage::Limit(24),
            ])
            .unwrap();
        paged.extend(names(&out));
    }

    assert_eq!(paged, names(&full[0..240]), "paging diverged from full sort");

    let unique: std::collections::HashSet<_> = paged.iter().collect();
    assert_eq!(unique.len(), paged.len(), "a document appeared on two pages");
}

#[test]
fn bounded_sort_is_deterministic_across_runs() {
    let db = db_with(300);
    let col = db.collection("items").unwrap();
    let once = col
        .aggregate(vec![Stage::Sort(sort_desc_score()), Stage::Limit(20)])
        .unwrap();
    for _ in 0..5 {
        let again = col
            .aggregate(vec![Stage::Sort(sort_desc_score()), Stage::Limit(20)])
            .unwrap();
        assert_eq!(names(&once), names(&again));
    }
}

#[test]
fn bounded_sort_survives_a_trailing_project() {
    // $project preserves count and order, so it must not defeat the bound.
    let db = db_with(200);
    let col = db.collection("items").unwrap();
    let out = col
        .aggregate(vec![
            Stage::Sort(sort_desc_score()),
            Stage::Skip(5),
            Stage::Limit(10),
            Stage::Project {
                fields: vec!["name".into()],
                include: true,
                keep_id: true,
            },
        ])
        .unwrap();
    assert_eq!(out.len(), 10);
    assert!(out[0].get("score").is_none());

    let full = col.aggregate(vec![Stage::Sort(sort_desc_score())]).unwrap();
    assert_eq!(names(&out), names(&full[5..15]));
}

#[test]
fn unbounded_sort_still_returns_everything() {
    // No $limit ⇒ no bound ⇒ the whole set, fully sorted, as before.
    let db = db_with(100);
    let col = db.collection("items").unwrap();
    let out = col
        .aggregate(vec![Stage::Sort(sort_desc_score()), Stage::Skip(10)])
        .unwrap();
    assert_eq!(out.len(), 90);
}

#[test]
fn limit_larger_than_collection_is_safe() {
    let db = db_with(7);
    let col = db.collection("items").unwrap();
    let out = col
        .aggregate(vec![Stage::Sort(sort_desc_score()), Stage::Limit(1000)])
        .unwrap();
    assert_eq!(out.len(), 7);
}

#[test]
fn sort_after_group_is_not_bounded_away() {
    // A $group between the scan and the sort changes the document set; the
    // bound must be computed over the *grouped* rows, not the raw ones.
    use taladb_core::aggregate::{Accumulator, GroupKey};
    let db = db_with(100);
    let col = db.collection("items").unwrap();
    let out = col
        .aggregate(vec![
            Stage::Group {
                key: GroupKey::Field("score".into()),
                accumulators: vec![("n".into(), Accumulator::Count)],
            },
            Stage::Sort(vec![SortSpec {
                field: "n".into(),
                direction: SortDirection::Desc,
            }]),
            Stage::Limit(3),
        ])
        .unwrap();
    assert_eq!(out.len(), 3); // 10 distinct scores → 10 groups → top 3
}
