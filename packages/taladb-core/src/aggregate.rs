//! Aggregation pipeline for TalaDB.
//!
//! A pipeline is a sequence of [`Stage`]s applied to a collection's documents in order.
//!
//! # Supported stages
//!
//! | Stage | Description |
//! |---|---|
//! | `$match` | Filter documents (uses query index when available) |
//! | `$group` | Group by a field and compute per-group accumulators |
//! | `$sort`  | Sort the result set |
//! | `$skip`  | Skip N documents |
//! | `$limit` | Keep the first N documents |
//! | `$project` | Keep only the listed fields |
//!
//! # Example
//!
//! ```ignore
//! use taladb_core::aggregate::{Accumulator, GroupKey, Pipeline, Stage};
//! use taladb_core::query::Filter;
//! use taladb_core::query::options::SortSpec;
//!
//! let result = col.aggregate(vec![
//!     Stage::Match(Filter::Eq("status".into(), Value::Str("active".into()))),
//!     Stage::Group {
//!         key: GroupKey::Field("department".into()),
//!         accumulators: vec![
//!             ("total_salary".into(), Accumulator::Sum("salary".into())),
//!             ("count".into(), Accumulator::Count),
//!             ("avg_salary".into(), Accumulator::Avg("salary".into())),
//!         ],
//!     },
//!     Stage::Sort(vec![SortSpec::desc("total_salary")]),
//!     Stage::Limit(10),
//! ])?;
//! ```

use std::collections::HashMap;

use crate::document::{Document, Value};
use crate::error::TalaDbError;
use crate::query::options::{sort_documents, SortSpec};

// ---------------------------------------------------------------------------
// Pipeline types
// ---------------------------------------------------------------------------

/// Key to group documents by in a `$group` stage.
#[derive(Debug, Clone)]
pub enum GroupKey {
    /// Group by the value of a single field. Documents where the field is
    /// absent are grouped under `Value::Null`.
    Field(String),
    /// Treat all documents as a single group (like SQL `GROUP BY NULL`).
    Null,
}

/// A per-group accumulator expression.
#[derive(Debug, Clone)]
pub enum Accumulator {
    /// Sum the numeric values of `field` across all documents in the group.
    Sum(String),
    /// Compute the arithmetic mean of `field` across the group.
    Avg(String),
    /// Return the minimum value of `field` in the group.
    Min(String),
    /// Return the maximum value of `field` in the group.
    Max(String),
    /// Count of documents in the group.
    Count,
    /// Collect all values of `field` into an array (like SQL `array_agg`).
    Push(String),
    /// Collect unique values of `field` into an array.
    AddToSet(String),
    /// Return the first value of `field` encountered in the group.
    First(String),
    /// Return the last value of `field` encountered in the group.
    Last(String),
}

/// A single pipeline stage.
#[derive(Debug, Clone)]
pub enum Stage {
    /// Filter documents. Uses the collection's indexes when run as the first stage.
    Match(crate::query::Filter),
    /// Group documents and compute accumulators.
    Group {
        key: GroupKey,
        /// `(output_field_name, accumulator)` pairs.
        accumulators: Vec<(String, Accumulator)>,
    },
    /// Sort the current document set.
    Sort(Vec<SortSpec>),
    /// Skip the first N documents.
    Skip(u64),
    /// Keep only the first N documents.
    Limit(u64),
    /// Keep only the listed fields (plus `_id` for Group results).
    Project(Vec<String>),
}

/// A pipeline is an ordered list of stages.
pub type Pipeline = Vec<Stage>;

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Execute a pipeline starting from `input` documents.
///
/// `input` is the full collection scan (or index-filtered results from the
/// first `$match` stage — handled by `Collection::aggregate`).
pub fn execute_pipeline(
    mut docs: Vec<Document>,
    pipeline: &[Stage],
) -> Result<Vec<Document>, TalaDbError> {
    for stage in pipeline {
        docs = apply_stage(docs, stage)?;
    }
    Ok(docs)
}

fn apply_stage(docs: Vec<Document>, stage: &Stage) -> Result<Vec<Document>, TalaDbError> {
    match stage {
        Stage::Match(filter) => Ok(docs.into_iter().filter(|d| filter.matches(d)).collect()),

        Stage::Group { key, accumulators } => apply_group(docs, key, accumulators),

        Stage::Sort(specs) => {
            let mut out = docs;
            sort_documents(&mut out, specs);
            Ok(out)
        }

        Stage::Skip(n) => {
            let n = *n as usize;
            if n >= docs.len() {
                Ok(vec![])
            } else {
                Ok(docs.into_iter().skip(n).collect())
            }
        }

        Stage::Limit(n) => Ok(docs.into_iter().take(*n as usize).collect()),

        Stage::Project(fields) => Ok(docs
            .into_iter()
            .map(|mut d| {
                d.fields.retain(|(k, _)| fields.iter().any(|f| f == k));
                d
            })
            .collect()),
    }
}

// ---------------------------------------------------------------------------
// $group implementation
// ---------------------------------------------------------------------------

/// Mutable per-group accumulator state.
enum AccState {
    Sum(f64),
    AvgState { sum: f64, count: u64 },
    Min(Option<Value>),
    Max(Option<Value>),
    Count(u64),
    Push(Vec<Value>),
    AddToSet(Vec<Value>),
    First(Option<Value>),
    Last(Option<Value>),
}

fn make_state(acc: &Accumulator) -> AccState {
    match acc {
        Accumulator::Sum(_) => AccState::Sum(0.0),
        Accumulator::Avg(_) => AccState::AvgState { sum: 0.0, count: 0 },
        Accumulator::Min(_) => AccState::Min(None),
        Accumulator::Max(_) => AccState::Max(None),
        Accumulator::Count => AccState::Count(0),
        Accumulator::Push(_) => AccState::Push(vec![]),
        Accumulator::AddToSet(_) => AccState::AddToSet(vec![]),
        Accumulator::First(_) => AccState::First(None),
        Accumulator::Last(_) => AccState::Last(None),
    }
}

fn update_state(state: &mut AccState, acc: &Accumulator, doc: &Document) {
    match (state, acc) {
        (AccState::Sum(s), Accumulator::Sum(f)) => {
            if let Some(v) = doc.get(f) {
                *s += numeric_to_f64(v).unwrap_or(0.0);
            }
        }
        (AccState::AvgState { sum, count }, Accumulator::Avg(f)) => {
            if let Some(v) = doc.get(f) {
                if let Some(n) = numeric_to_f64(v) {
                    *sum += n;
                    *count += 1;
                }
            }
        }
        (AccState::Min(cur), Accumulator::Min(f)) => {
            if let Some(v) = doc.get(f) {
                *cur = Some(match cur.take() {
                    None => v.clone(),
                    Some(existing) => {
                        if value_lt(v, &existing) {
                            v.clone()
                        } else {
                            existing
                        }
                    }
                });
            }
        }
        (AccState::Max(cur), Accumulator::Max(f)) => {
            if let Some(v) = doc.get(f) {
                *cur = Some(match cur.take() {
                    None => v.clone(),
                    Some(existing) => {
                        if value_lt(&existing, v) {
                            v.clone()
                        } else {
                            existing
                        }
                    }
                });
            }
        }
        (AccState::Count(n), Accumulator::Count) => *n += 1,
        (AccState::Push(arr), Accumulator::Push(f)) => {
            if let Some(v) = doc.get(f) {
                arr.push(v.clone());
            }
        }
        (AccState::AddToSet(arr), Accumulator::AddToSet(f)) => {
            if let Some(v) = doc.get(f) {
                if !arr.contains(v) {
                    arr.push(v.clone());
                }
            }
        }
        (AccState::First(cur), Accumulator::First(f)) => {
            if cur.is_none() {
                *cur = doc.get(f).cloned();
            }
        }
        (AccState::Last(cur), Accumulator::Last(f)) => {
            *cur = doc.get(f).cloned();
        }
        _ => {}
    }
}

fn finalize_state(state: AccState) -> Value {
    match state {
        AccState::Sum(s) => float_or_int(s),
        AccState::AvgState { sum, count } => {
            if count == 0 {
                Value::Null
            } else {
                Value::Float(sum / count as f64)
            }
        }
        AccState::Min(v) | AccState::Max(v) | AccState::First(v) | AccState::Last(v) => {
            v.unwrap_or(Value::Null)
        }
        AccState::Count(n) => Value::Int(n as i64),
        AccState::Push(arr) | AccState::AddToSet(arr) => Value::Array(arr),
    }
}

fn apply_group(
    docs: Vec<Document>,
    key: &GroupKey,
    accumulators: &[(String, Accumulator)],
) -> Result<Vec<Document>, TalaDbError> {
    // Map from group-key string → (group_key_value, Vec<AccState>)
    let mut groups: HashMap<String, (Value, Vec<AccState>)> = HashMap::new();

    for doc in &docs {
        let group_val = match key {
            GroupKey::Field(f) => doc.get(f).cloned().unwrap_or(Value::Null),
            GroupKey::Null => Value::Null,
        };
        let group_str = value_to_key_string(&group_val);

        let entry = groups.entry(group_str).or_insert_with(|| {
            let states = accumulators.iter().map(|(_, a)| make_state(a)).collect();
            (group_val.clone(), states)
        });

        for (i, (_, acc)) in accumulators.iter().enumerate() {
            update_state(&mut entry.1[i], acc, doc);
        }
    }

    // Build output documents: _id = group key, + one field per accumulator
    let mut out: Vec<Document> = groups
        .into_values()
        .map(|(group_val, states)| {
            let mut fields: Vec<(String, Value)> = vec![("_id".into(), group_val)];
            for ((name, _), state) in accumulators.iter().zip(states) {
                fields.push((name.clone(), finalize_state(state)));
            }
            // Use a nil ULID for group result rows — they are not real documents
            Document::with_id(ulid::Ulid::nil(), fields)
        })
        .collect();

    out.sort_by_key(|d| value_to_key_string(d.get("_id").unwrap_or(&Value::Null)));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn numeric_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Int(n) => Some(*n as f64),
        Value::Float(f) => Some(*f),
        _ => None,
    }
}

fn float_or_int(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < i64::MAX as f64 {
        Value::Int(f as i64)
    } else {
        Value::Float(f)
    }
}

fn value_lt(a: &Value, b: &Value) -> bool {
    matches!(a.partial_cmp_numeric(b), Some(std::cmp::Ordering::Less))
        || matches!((a, b), (Value::Str(x), Value::Str(y)) if x < y)
}

/// Produce a stable string key for HashMap grouping.
fn value_to_key_string(v: &Value) -> String {
    match v {
        Value::Null => "\x00null".into(),
        Value::Bool(b) => format!("\x01{}", b),
        Value::Int(n) => format!("\x02{:020}", n + i64::MIN),
        Value::Float(f) => format!("\x03{:e}", f),
        Value::Str(s) => format!("\x04{}", s),
        Value::Bytes(b) => format!("\x05{:?}", b),
        Value::Array(_) | Value::Object(_) => format!("\x06{:?}", v),
    }
}
