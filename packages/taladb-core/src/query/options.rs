//! Query options — sort, pagination, and projection for `find_with_options`.

use crate::document::{Document, Value};

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

/// Direction for a sort key.
#[derive(Debug, Clone, PartialEq)]
pub enum SortDirection {
    /// Ascending (A→Z, 0→9, false→true).
    Asc,
    /// Descending (Z→A, 9→0, true→false).
    Desc,
}

/// A single sort key: field name + direction.
#[derive(Debug, Clone)]
pub struct SortSpec {
    pub field: String,
    pub direction: SortDirection,
}

impl SortSpec {
    pub fn asc(field: impl Into<String>) -> Self {
        SortSpec {
            field: field.into(),
            direction: SortDirection::Asc,
        }
    }
    pub fn desc(field: impl Into<String>) -> Self {
        SortSpec {
            field: field.into(),
            direction: SortDirection::Desc,
        }
    }
}

// ---------------------------------------------------------------------------
// FindOptions
// ---------------------------------------------------------------------------

/// Options for `Collection::find_with_options`.
///
/// All fields are optional; an empty `FindOptions` is equivalent to calling
/// the plain `find` method.
///
/// ```
/// use taladb_core::query::options::{FindOptions, SortSpec};
///
/// let opts = FindOptions {
///     sort: vec![SortSpec::desc("createdAt"), SortSpec::asc("name")],
///     skip: 20,
///     limit: Some(10),
///     fields: Some(vec!["name".into(), "email".into()]),
///     timeout: Some(std::time::Duration::from_secs(5)),
/// };
/// ```
#[derive(Debug, Default, Clone)]
pub struct FindOptions {
    /// Sort order — applied after filtering, before skip/limit.
    /// Multiple specs are applied left-to-right (primary key first).
    pub sort: Vec<SortSpec>,
    /// Number of documents to skip from the front of the result set.
    pub skip: u64,
    /// Maximum number of documents to return (`None` = unlimited).
    pub limit: Option<u64>,
    /// If `Some`, only the listed fields (plus `_id`) are returned.
    /// Fields not in the list are stripped from each document.
    pub fields: Option<Vec<String>>,
    /// If `Some`, the query will return [`TalaDbError::QueryTimeout`] if
    /// it runs longer than the specified duration.  The check is performed
    /// between documents in the filter loop, so the actual elapsed time may
    /// slightly exceed the limit on very large individual documents.
    pub timeout: Option<std::time::Duration>,
}

// ---------------------------------------------------------------------------
// Sort comparison
// ---------------------------------------------------------------------------

/// Compare two `Value`s for ordering.
///
/// Ordering is defined as:
///   Null < Bool < Int/Float (numeric) < Str < Bytes < Array < Object
///
/// Mixed numeric types (Int vs Float) are compared numerically.
fn cmp_values(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Null, _) => Ordering::Less,
        (_, Value::Null) => Ordering::Greater,

        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Bool(_), _) => Ordering::Less,
        (_, Value::Bool(_)) => Ordering::Greater,

        // Numeric: Int and Float compare numerically across types
        (Value::Int(x), Value::Int(y)) => x.cmp(y),
        (Value::Float(x), Value::Float(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (Value::Int(x), Value::Float(y)) => (*x as f64).partial_cmp(y).unwrap_or(Ordering::Equal),
        (Value::Float(x), Value::Int(y)) => x.partial_cmp(&(*y as f64)).unwrap_or(Ordering::Equal),
        (Value::Int(_) | Value::Float(_), _) => Ordering::Less,
        (_, Value::Int(_) | Value::Float(_)) => Ordering::Greater,

        (Value::Str(x), Value::Str(y)) => x.cmp(y),
        (Value::Str(_), _) => Ordering::Less,
        (_, Value::Str(_)) => Ordering::Greater,

        (Value::Bytes(x), Value::Bytes(y)) => x.cmp(y),
        (Value::Bytes(_), _) => Ordering::Less,
        (_, Value::Bytes(_)) => Ordering::Greater,

        // Arrays and objects — compare by debug representation (stable but not meaningful)
        _ => Ordering::Equal,
    }
}

/// Multi-key comparator that follows the `sort` spec list.
fn cmp_by_spec(a: &Document, b: &Document, sort: &[SortSpec]) -> std::cmp::Ordering {
    for spec in sort {
        let av = a.get(&spec.field);
        let bv = b.get(&spec.field);
        let ord = match (av, bv) {
            (Some(x), Some(y)) => cmp_values(x, y),
            (None, Some(_)) => std::cmp::Ordering::Less,
            (Some(_), None) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        let ord = if spec.direction == SortDirection::Desc {
            ord.reverse()
        } else {
            ord
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    std::cmp::Ordering::Equal
}

/// Sort `docs` in-place according to the given `sort` specs.
pub fn sort_documents(docs: &mut [Document], sort: &[SortSpec]) {
    if sort.is_empty() {
        return;
    }
    docs.sort_by(|a, b| cmp_by_spec(a, b, sort));
}

/// Sort only the first `keep` documents — the rest are discarded.
///
/// Complexity: O(n + k log k) where n = docs.len() and k = keep. Use when
/// the caller only needs the smallest/first `keep` documents (e.g. `find`
/// with sort + limit), instead of paying for a full O(n log n) sort.
///
/// Returns with `docs.len() == min(keep, docs.len())` and the first `keep`
/// elements sorted according to `sort`.
pub fn partial_sort_documents(docs: &mut Vec<Document>, sort: &[SortSpec], keep: usize) {
    if sort.is_empty() {
        docs.truncate(keep);
        return;
    }
    if keep >= docs.len() {
        docs.sort_by(|a, b| cmp_by_spec(a, b, sort));
        return;
    }
    if keep == 0 {
        docs.clear();
        return;
    }
    // Partition so the first `keep` slots contain the `keep` smallest docs
    // (in arbitrary order), then sort just those.
    docs.select_nth_unstable_by(keep - 1, |a, b| cmp_by_spec(a, b, sort));
    docs.truncate(keep);
    docs.sort_by(|a, b| cmp_by_spec(a, b, sort));
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/// Apply a projection to a document: keep only the listed fields (plus `_id`).
pub fn project_document(mut doc: Document, fields: &[String]) -> Document {
    doc.fields.retain(|(k, _)| fields.iter().any(|f| f == k));
    doc
}
