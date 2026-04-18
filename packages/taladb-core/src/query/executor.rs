use std::collections::HashSet;
use std::ops::Bound;
use std::time::Instant;

use ulid::Ulid;

use crate::document::{Document, Value};
use crate::engine::ReadTxn;
use crate::error::TalaDbError;
use crate::fts::{fts_table_name, fts_token_range, tokenize, ulid_from_fts_key};
use crate::index::{compound_table_name, docs_table_name, index_table_name, ulid_from_index_key};
use crate::query::filter::Filter;
use crate::query::planner::QueryPlan;

/// Execute a query plan and return matching documents.
/// The `filter` is always applied as a post-filter to eliminate false positives.
///
/// `deadline` — if `Some`, the executor checks elapsed time in the document
/// filter loop and returns [`TalaDbError::QueryTimeout`] if the deadline is
/// exceeded.
pub fn execute(
    plan: &QueryPlan,
    filter: &Filter,
    txn: &dyn ReadTxn,
    collection: &str,
    deadline: Option<Instant>,
) -> Result<Vec<Document>, TalaDbError> {
    // Check deadline up-front so callers that pass an already-expired deadline
    // don't touch storage at all.
    check_deadline(deadline)?;

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
            check_deadline(deadline)?;
            fetch_by_ulids(txn, collection, ulids)?
        }

        QueryPlan::IndexRange { field, start, end } => {
            let start_ref = bound_as_ref(start);
            let end_ref = bound_as_ref(end);
            let ulids = index_range_scan(txn, collection, field, start_ref, end_ref)?;
            check_deadline(deadline)?;
            fetch_by_ulids(txn, collection, ulids)?
        }

        QueryPlan::IndexIn { field, ranges } => {
            let mut ulids: Vec<Ulid> = Vec::new();
            for (start, end) in ranges {
                check_deadline(deadline)?;
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
                check_deadline(deadline)?;
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

        QueryPlan::CompoundIndexEq { fields, start, end } => {
            let field_refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
            let table = compound_table_name(collection, &field_refs);
            let ulids = table_range_scan(
                txn,
                &table,
                Bound::Included(start.as_slice()),
                Bound::Included(end.as_slice()),
            )?;
            fetch_by_ulids(txn, collection, ulids)?
        }

        // Union the results of multiple index-backed sub-plans, deduplicating by ULID
        // before loading documents to avoid fetching the same document multiple times.
        QueryPlan::IndexOr { plans } => {
            let mut seen: HashSet<[u8; 16]> = HashSet::new();
            for sub_plan in plans {
                check_deadline(deadline)?;
                let ulids = collect_ulids(sub_plan, txn, collection, deadline)?;
                for id_bytes in ulids {
                    seen.insert(id_bytes);
                }
            }
            let ulids: Vec<Ulid> = seen.into_iter().map(Ulid::from_bytes).collect();
            fetch_by_ulids(txn, collection, ulids)?
        }
    };

    check_deadline(deadline)?;

    // Pre-tokenize Contains query once before the document loop to avoid
    // re-tokenizing the same query string for every candidate document.
    if let Filter::Contains(field, query) = filter {
        let query_tokens = tokenize(query);
        let mut results = Vec::with_capacity(candidates.len());
        for d in candidates {
            if let Some(dl) = deadline {
                if Instant::now() >= dl {
                    return Err(TalaDbError::QueryTimeout);
                }
            }
            let matches = if query_tokens.is_empty() {
                true
            } else if let Some(Value::Str(text)) = d.get(field) {
                let doc_tokens = tokenize(text);
                query_tokens
                    .iter()
                    .all(|qt| doc_tokens.iter().any(|dt| dt == qt))
            } else {
                false
            };
            if matches {
                results.push(d);
            }
        }
        return Ok(results);
    }

    // Pre-compile Regex once before the document loop. A malformed pattern
    // fails fast here instead of silently returning zero matches per doc.
    if let Filter::Regex(field, pattern) = filter {
        let re = regex::RegexBuilder::new(pattern)
            .size_limit(1 << 20)
            .dfa_size_limit(1 << 20)
            .build()
            .map_err(|e| TalaDbError::InvalidFilter(format!("regex: {e}")))?;
        let mut results = Vec::with_capacity(candidates.len());
        for d in candidates {
            if let Some(dl) = deadline {
                if Instant::now() >= dl {
                    return Err(TalaDbError::QueryTimeout);
                }
            }
            let matches = matches!(d.get(field), Some(Value::Str(text)) if re.is_match(text));
            if matches {
                results.push(d);
            }
        }
        return Ok(results);
    }

    let mut results = Vec::with_capacity(candidates.len());
    for d in candidates {
        if let Some(dl) = deadline {
            if Instant::now() >= dl {
                return Err(TalaDbError::QueryTimeout);
            }
        }
        if filter.matches(&d) {
            results.push(d);
        }
    }
    Ok(results)
}

/// Collect raw ULID bytes from an index-backed plan without loading documents.
/// Used by `IndexOr` to deduplicate before fetching.
fn collect_ulids(
    plan: &QueryPlan,
    txn: &dyn ReadTxn,
    collection: &str,
    deadline: Option<Instant>,
) -> Result<Vec<[u8; 16]>, TalaDbError> {
    match plan {
        QueryPlan::IndexEq { field, start, end } => {
            let ulids = index_range_scan(
                txn,
                collection,
                field,
                Bound::Included(start.as_slice()),
                Bound::Included(end.as_slice()),
            )?;
            Ok(ulids.into_iter().map(|u| u.to_bytes()).collect())
        }
        QueryPlan::IndexRange { field, start, end } => {
            let start_ref = bound_as_ref(start);
            let end_ref = bound_as_ref(end);
            let ulids = index_range_scan(txn, collection, field, start_ref, end_ref)?;
            Ok(ulids.into_iter().map(|u| u.to_bytes()).collect())
        }
        QueryPlan::IndexIn { field, ranges } => {
            let mut result: Vec<[u8; 16]> = Vec::new();
            for (start, end) in ranges {
                let batch = index_range_scan(
                    txn,
                    collection,
                    field,
                    Bound::Included(start.as_slice()),
                    Bound::Included(end.as_slice()),
                )?;
                result.extend(batch.into_iter().map(|u| u.to_bytes()));
            }
            Ok(result)
        }
        QueryPlan::CompoundIndexEq { fields, start, end } => {
            let field_refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
            let table = compound_table_name(collection, &field_refs);
            let ulids = table_range_scan(
                txn,
                &table,
                Bound::Included(start.as_slice()),
                Bound::Included(end.as_slice()),
            )?;
            Ok(ulids.into_iter().map(|u| u.to_bytes()).collect())
        }
        _ => {
            // For non-index plans, fall back to executing and extracting ids
            let docs = execute(plan, &Filter::All, txn, collection, deadline)?;
            Ok(docs.into_iter().map(|d| d.id.to_bytes()).collect())
        }
    }
}

#[inline]
fn check_deadline(deadline: Option<Instant>) -> Result<(), TalaDbError> {
    if let Some(dl) = deadline {
        if Instant::now() >= dl {
            return Err(TalaDbError::QueryTimeout);
        }
    }
    Ok(())
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
    table_range_scan(txn, &table, start, end)
}

fn table_range_scan(
    txn: &dyn ReadTxn,
    table: &str,
    start: Bound<&[u8]>,
    end: Bound<&[u8]>,
) -> Result<Vec<Ulid>, TalaDbError> {
    let entries = txn.range(table, start, end)?;
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
