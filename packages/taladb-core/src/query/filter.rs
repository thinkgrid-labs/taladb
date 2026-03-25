use serde::{Deserialize, Serialize};

use crate::document::{Document, Value};

/// MongoDB-inspired filter AST.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Filter {
    /// Matches all documents.
    All,
    /// field == value
    Eq(String, Value),
    /// field != value
    Ne(String, Value),
    /// field > value
    Gt(String, Value),
    /// field >= value
    Gte(String, Value),
    /// field < value
    Lt(String, Value),
    /// field <= value
    Lte(String, Value),
    /// field in [values]
    In(String, Vec<Value>),
    /// field not in [values]
    Nin(String, Vec<Value>),
    /// field exists / does not exist
    Exists(String, bool),
    /// $and
    And(Vec<Filter>),
    /// $or
    Or(Vec<Filter>),
    /// $not
    Not(Box<Filter>),
    /// Full-text search: field contains all tokens from the query string.
    /// Requires a full-text index created with `Collection::create_fts_index`.
    Contains(String, String),
}

impl Filter {
    /// Evaluate this filter against a document. Used as a post-filter after index scans.
    pub fn matches(&self, doc: &Document) -> bool {
        match self {
            Filter::All => true,

            Filter::Eq(field, val) => doc.get(field).is_some_and(|v| v == val),

            Filter::Ne(field, val) => doc.get(field).is_none_or(|v| v != val),

            Filter::Gt(field, val) => doc
                .get(field)
                .and_then(|v| v.partial_cmp_numeric(val))
                .is_some_and(|ord| ord == std::cmp::Ordering::Greater),

            Filter::Gte(field, val) => doc
                .get(field)
                .and_then(|v| v.partial_cmp_numeric(val))
                .is_some_and(|ord| ord != std::cmp::Ordering::Less),

            Filter::Lt(field, val) => doc
                .get(field)
                .and_then(|v| v.partial_cmp_numeric(val))
                .is_some_and(|ord| ord == std::cmp::Ordering::Less),

            Filter::Lte(field, val) => doc
                .get(field)
                .and_then(|v| v.partial_cmp_numeric(val))
                .is_some_and(|ord| ord != std::cmp::Ordering::Greater),

            Filter::In(field, vals) => doc
                .get(field)
                .is_some_and(|v| vals.contains(v)),

            Filter::Nin(field, vals) => doc
                .get(field)
                .is_none_or(|v| !vals.contains(v)),

            Filter::Exists(field, should_exist) => {
                doc.contains_key(field) == *should_exist
            }

            Filter::And(filters) => filters.iter().all(|f| f.matches(doc)),

            Filter::Or(filters) => filters.iter().any(|f| f.matches(doc)),

            Filter::Not(inner) => !inner.matches(doc),

            // Post-filter: check all tokens appear in the field value
            Filter::Contains(field, query) => {
                use crate::fts::tokenize;
                let query_tokens = tokenize(query);
                if query_tokens.is_empty() {
                    return true;
                }
                if let Some(Value::Str(text)) = doc.get(field) {
                    let doc_tokens = tokenize(text);
                    query_tokens.iter().all(|qt| doc_tokens.iter().any(|dt| dt == qt))
                } else {
                    false
                }
            }
        }
    }

    /// Return the single indexed field this filter constrains, if any.
    /// Used by the query planner to select an index.
    pub fn primary_field(&self) -> Option<&str> {
        match self {
            Filter::Eq(f, _)
            | Filter::Ne(f, _)
            | Filter::Gt(f, _)
            | Filter::Gte(f, _)
            | Filter::Lt(f, _)
            | Filter::Lte(f, _)
            | Filter::In(f, _)
            | Filter::Nin(f, _)
            | Filter::Exists(f, _) => Some(f.as_str()),
            Filter::And(filters) => filters.iter().find_map(|f| f.primary_field()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ulid::Ulid;

    fn doc(fields: Vec<(&str, Value)>) -> Document {
        Document::with_id(
            Ulid::nil(),
            fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        )
    }

    #[test]
    fn basic_eq() {
        let d = doc(vec![("age", Value::Int(30))]);
        assert!(Filter::Eq("age".into(), Value::Int(30)).matches(&d));
        assert!(!Filter::Eq("age".into(), Value::Int(31)).matches(&d));
    }

    #[test]
    fn range_ops() {
        let d = doc(vec![("score", Value::Float(7.5))]);
        assert!(Filter::Gt("score".into(), Value::Float(7.0)).matches(&d));
        assert!(!Filter::Gt("score".into(), Value::Float(8.0)).matches(&d));
        assert!(Filter::Lte("score".into(), Value::Float(7.5)).matches(&d));
    }

    #[test]
    fn and_or() {
        let d = doc(vec![("a", Value::Int(1)), ("b", Value::Int(2))]);
        let f = Filter::And(vec![
            Filter::Eq("a".into(), Value::Int(1)),
            Filter::Eq("b".into(), Value::Int(2)),
        ]);
        assert!(f.matches(&d));
        let f2 = Filter::Or(vec![
            Filter::Eq("a".into(), Value::Int(99)),
            Filter::Eq("b".into(), Value::Int(2)),
        ]);
        assert!(f2.matches(&d));
    }

    #[test]
    fn exists() {
        let d = doc(vec![("x", Value::Null)]);
        assert!(Filter::Exists("x".into(), true).matches(&d));
        assert!(!Filter::Exists("y".into(), true).matches(&d));
        assert!(Filter::Exists("y".into(), false).matches(&d));
    }
}
