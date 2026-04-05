use std::collections::HashSet;
use std::ops::Bound;

use ulid::Ulid;

use crate::document::Document;
use crate::engine::ReadTxn;
use crate::error::TalaDbError;
use crate::fts::{fts_table_name, fts_token_range, ulid_from_fts_key};
use crate::index::{docs_table_name, index_table_name, ulid_from_index_key};
use crate::query::filter::Filter;
use crate::query::planner::QueryPlan;

/// Execute a query plan and return matching documents.
/// The `filter` is always applied as a post-filter to eliminate false positives.
pub fn execute(
    plan: &QueryPlan,
    filter: &Filter,
    txn: &dyn ReadTxn,
    collection: &str,
) -> Result<Vec<Document>, TalaDbError> {
    let candidates = match plan {
        QueryPlan::FullScan => full_scan(txn, collection)?,

        QueryPlan::IndexEq { field, start, end } => {
            let ulids = index_range_scan(
                txn,
                collection,
                field,
                Bound::Included(start.as_slice()),
                Bound::Included(end.as_slice()),
            )?;
            fetch_by_ulids(txn, collection, ulids)?
        }

        QueryPlan::IndexRange { field, start, end } => {
            let start_ref = bound_as_ref(start);
            let end_ref = bound_as_ref(end);
            let ulids = index_range_scan(txn, collection, field, start_ref, end_ref)?;
            fetch_by_ulids(txn, collection, ulids)?
        }

        QueryPlan::IndexIn { field, ranges } => {
            let mut ulids: Vec<Ulid> = Vec::new();
            for (start, end) in ranges {
                let mut batch = index_range_scan(
                    txn,
                    collection,
                    field,
                    Bound::Included(start.as_slice()),
                    Bound::Included(end.as_slice()),
                )?;
                ulids.append(&mut batch);
            }
            ulids.dedup();
            fetch_by_ulids(txn, collection, ulids)?
        }

        // Full-text search: intersect ULID sets across all query tokens (AND semantics).
        QueryPlan::FtsSearch { field, tokens } => {
            if tokens.is_empty() {
                return Ok(vec![]);
            }
            // Collect ULID sets per token, then intersect
            let mut ulid_sets: Vec<HashSet<[u8; 16]>> = Vec::with_capacity(tokens.len());
            for token in tokens {
                let (start, end) = fts_token_range(token);
                let table = fts_table_name(collection, field);
                let entries = txn.range(
                    &table,
                    Bound::Included(start.as_slice()),
                    Bound::Included(end.as_slice()),
                )?;
                let set: HashSet<[u8; 16]> = entries
                    .into_iter()
                    .filter_map(|(k, _)| ulid_from_fts_key(&k).map(|u| u.to_bytes()))
                    .collect();
                ulid_sets.push(set);
            }
            // Intersect all sets — documents must contain every token
            let intersection = ulid_sets
                .into_iter()
                .reduce(|a, b| a.into_iter().filter(|u| b.contains(u)).collect())
                .unwrap_or_default();
            let ulids: Vec<Ulid> = intersection.into_iter().map(Ulid::from_bytes).collect();
            fetch_by_ulids(txn, collection, ulids)?
        }

        // Union the results of multiple index-backed sub-plans, deduplicating by ULID.
        QueryPlan::IndexOr { plans } => {
            let mut seen: HashSet<[u8; 16]> = HashSet::new();
            let mut docs: Vec<Document> = Vec::new();
            for sub_plan in plans {
                let batch = execute(sub_plan, &Filter::All, txn, collection)?;
                for doc in batch {
                    let key = doc.id.to_bytes();
                    if seen.insert(key) {
                        docs.push(doc);
                    }
                }
            }
            docs
        }
    };

    Ok(candidates
        .into_iter()
        .filter(|d| filter.matches(d))
        .collect())
}

fn bound_as_ref(b: &Bound<Vec<u8>>) -> Bound<&[u8]> {
    match b {
        Bound::Included(v) => Bound::Included(v.as_slice()),
        Bound::Excluded(v) => Bound::Excluded(v.as_slice()),
        Bound::Unbounded => Bound::Unbounded,
    }
}

fn full_scan(txn: &dyn ReadTxn, collection: &str) -> Result<Vec<Document>, TalaDbError> {
    let table = docs_table_name(collection);
    let entries = txn.scan_all(&table)?;
    let mut docs = Vec::with_capacity(entries.len());
    for (_, v) in entries {
        let doc: Document = postcard::from_bytes(&v)?;
        docs.push(doc);
    }
    Ok(docs)
}

fn index_range_scan(
    txn: &dyn ReadTxn,
    collection: &str,
    field: &str,
    start: Bound<&[u8]>,
    end: Bound<&[u8]>,
) -> Result<Vec<Ulid>, TalaDbError> {
    let table = index_table_name(collection, field);
    let entries = txn.range(&table, start, end)?;
    let ulids = entries
        .into_iter()
        .filter_map(|(k, _)| ulid_from_index_key(&k))
        .collect();
    Ok(ulids)
}

fn fetch_by_ulids(
    txn: &dyn ReadTxn,
    collection: &str,
    ulids: Vec<Ulid>,
) -> Result<Vec<Document>, TalaDbError> {
    let table = docs_table_name(collection);
    let mut docs = Vec::with_capacity(ulids.len());
    for ulid in ulids {
        let key = ulid.to_bytes();
        if let Some(bytes) = txn.get(&table, &key)? {
            let doc: Document = postcard::from_bytes(&bytes)?;
            docs.push(doc);
        }
    }
    Ok(docs)
}
