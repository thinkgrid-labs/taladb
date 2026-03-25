use std::ops::Bound;

use crate::fts::FtsDef;
use crate::index::{index_range_cmp, index_range_eq, IndexDef};
use crate::query::filter::Filter;

/// The execution plan produced by the query planner.
#[derive(Debug)]
pub enum QueryPlan {
    /// No usable index — scan all documents in the collection.
    FullScan,

    /// Use an index to do an exact equality lookup.
    IndexEq {
        field: String,
        start: Vec<u8>,
        end: Vec<u8>,
    },

    /// Use an index for a range scan (gt/gte/lt/lte).
    IndexRange {
        field: String,
        start: Bound<Vec<u8>>,
        end: Bound<Vec<u8>>,
    },

    /// Use an index for an $in lookup (union of point lookups).
    IndexIn {
        field: String,
        ranges: Vec<(Vec<u8>, Vec<u8>)>, // (start, end) per value
    },

    /// Union the results of multiple index-backed sub-plans ($or when all
    /// branches are index-accelerated).
    IndexOr {
        plans: Vec<QueryPlan>,
    },

    /// Full-text search via the inverted token index.
    FtsSearch {
        field: String,
        /// Tokenized query terms — all must match (AND semantics).
        tokens: Vec<String>,
    },
}

/// Select the best execution plan for a filter given available indexes.
///
/// Strategy (greedy, not cost-based):
/// - For `And`, pick the first sub-filter that has an indexed field and convert it
///   to an index plan; remaining sub-filters become post-filters in the executor.
/// - For `Or`, use `IndexOr` when every branch is index-accelerated.
/// - `Contains` maps to `FtsSearch` when an FTS index exists for the field.
/// - Single equality / range / in — use index if available.
pub fn plan(filter: &Filter, indexes: &[IndexDef]) -> QueryPlan {
    plan_with_fts(filter, indexes, &[])
}

/// Extended planner that also considers full-text search indexes.
pub fn plan_with_fts(filter: &Filter, indexes: &[IndexDef], fts_indexes: &[FtsDef]) -> QueryPlan {
    let indexed_fields: Vec<&str> = indexes.iter().map(|i| i.field.as_str()).collect();
    let fts_fields: Vec<&str> = fts_indexes.iter().map(|i| i.field.as_str()).collect();
    plan_inner(filter, &indexed_fields, &fts_fields)
}

fn plan_inner(filter: &Filter, indexed_fields: &[&str], fts_fields: &[&str]) -> QueryPlan {

    match filter {
        Filter::All => QueryPlan::FullScan,

        Filter::Eq(field, value) if indexed_fields.contains(&field.as_str()) => {
            if let Some((start, end)) = index_range_eq(value) {
                return QueryPlan::IndexEq { field: field.clone(), start, end };
            }
            QueryPlan::FullScan
        }

        Filter::Gt(field, value) if indexed_fields.contains(&field.as_str()) => {
            if let Some((start, end)) = index_range_cmp(Some((value, false)), None) {
                return QueryPlan::IndexRange { field: field.clone(), start, end };
            }
            QueryPlan::FullScan
        }

        Filter::Gte(field, value) if indexed_fields.contains(&field.as_str()) => {
            if let Some((start, end)) = index_range_cmp(Some((value, true)), None) {
                return QueryPlan::IndexRange { field: field.clone(), start, end };
            }
            QueryPlan::FullScan
        }

        Filter::Lt(field, value) if indexed_fields.contains(&field.as_str()) => {
            if let Some((start, end)) = index_range_cmp(None, Some((value, false))) {
                return QueryPlan::IndexRange { field: field.clone(), start, end };
            }
            QueryPlan::FullScan
        }

        Filter::Lte(field, value) if indexed_fields.contains(&field.as_str()) => {
            if let Some((start, end)) = index_range_cmp(None, Some((value, true))) {
                return QueryPlan::IndexRange { field: field.clone(), start, end };
            }
            QueryPlan::FullScan
        }

        Filter::In(field, values) if indexed_fields.contains(&field.as_str()) => {
            let ranges: Vec<(Vec<u8>, Vec<u8>)> = values
                .iter()
                .filter_map(|v| index_range_eq(v))
                .collect();
            if !ranges.is_empty() {
                return QueryPlan::IndexIn { field: field.clone(), ranges };
            }
            QueryPlan::FullScan
        }

        // Full-text search — use FTS index when available
        Filter::Contains(field, query) if fts_fields.contains(&field.as_str()) => {
            use crate::fts::tokenize;
            let tokens = tokenize(query);
            if tokens.is_empty() {
                return QueryPlan::FullScan;
            }
            QueryPlan::FtsSearch { field: field.clone(), tokens }
        }

        // For And: try each sub-filter for an index, use first hit
        Filter::And(filters) => {
            for f in filters {
                let sub = plan_inner(f, indexed_fields, fts_fields);
                if !matches!(sub, QueryPlan::FullScan) {
                    return sub;
                }
            }
            QueryPlan::FullScan
        }

        // Or: use IndexOr only when every branch is index-backed
        Filter::Or(filters) => {
            let sub_plans: Vec<QueryPlan> = filters.iter()
                .map(|f| plan_inner(f, indexed_fields, fts_fields))
                .collect();
            if sub_plans.iter().all(|p| !matches!(p, QueryPlan::FullScan)) {
                return QueryPlan::IndexOr { plans: sub_plans };
            }
            QueryPlan::FullScan
        }

        // Not / Ne / Nin / Exists / unindexed Contains — full scan
        _ => QueryPlan::FullScan,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Value;

    fn indexes(fields: &[&str]) -> Vec<IndexDef> {
        fields.iter().map(|f| IndexDef {
            collection: "col".into(),
            field: f.to_string(),
        }).collect()
    }

    #[test]
    fn eq_with_index() {
        let f = Filter::Eq("age".into(), Value::Int(30));
        let plan = plan(&f, &indexes(&["age"]));
        assert!(matches!(plan, QueryPlan::IndexEq { .. }));
    }

    #[test]
    fn eq_without_index() {
        let f = Filter::Eq("age".into(), Value::Int(30));
        let plan = plan(&f, &indexes(&[]));
        assert!(matches!(plan, QueryPlan::FullScan));
    }

    #[test]
    fn range_with_index() {
        let f = Filter::Gte("score".into(), Value::Float(5.0));
        let plan = plan(&f, &indexes(&["score"]));
        assert!(matches!(plan, QueryPlan::IndexRange { .. }));
    }

    #[test]
    fn in_with_index() {
        let f = Filter::In("status".into(), vec![Value::Str("active".into()), Value::Str("pending".into())]);
        let plan = plan(&f, &indexes(&["status"]));
        assert!(matches!(plan, QueryPlan::IndexIn { .. }));
    }

    #[test]
    fn and_picks_indexed_subfilter() {
        let f = Filter::And(vec![
            Filter::Eq("unindexed".into(), Value::Int(1)),
            Filter::Eq("age".into(), Value::Int(30)),
        ]);
        let plan = plan(&f, &indexes(&["age"]));
        assert!(matches!(plan, QueryPlan::IndexEq { field, .. } if field == "age"));
    }

    #[test]
    fn or_all_indexed_uses_index_or() {
        let f = Filter::Or(vec![
            Filter::Eq("age".into(), Value::Int(30)),
            Filter::Eq("age".into(), Value::Int(40)),
        ]);
        let plan = plan(&f, &indexes(&["age"]));
        assert!(matches!(plan, QueryPlan::IndexOr { .. }));
    }

    #[test]
    fn or_partially_unindexed_falls_back() {
        let f = Filter::Or(vec![
            Filter::Eq("age".into(), Value::Int(30)),
            Filter::Eq("unindexed".into(), Value::Int(40)),
        ]);
        let plan = plan(&f, &indexes(&["age"]));
        assert!(matches!(plan, QueryPlan::FullScan));
    }
}
