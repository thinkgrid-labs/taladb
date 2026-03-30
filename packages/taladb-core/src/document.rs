use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use ulid::{Generator, Ulid};

thread_local! {
    static ULID_GEN: RefCell<Generator> = const { RefCell::new(Generator::new()) };
}

fn new_ulid() -> Ulid {
    ULID_GEN.with(|gen| {
        gen.borrow_mut().generate().unwrap_or_else(|_| Ulid::new())
    })
}

/// A dynamically-typed value that maps to JSON conceptually but serializes via postcard.
/// Uses Vec<(String, Value)> for objects (not HashMap) to guarantee deterministic serialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Int(_) => "int",
            Value::Float(_) => "float",
            Value::Str(_) => "string",
            Value::Bytes(_) => "bytes",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        if let Value::Bool(b) = self { Some(*b) } else { None }
    }

    pub fn as_int(&self) -> Option<i64> {
        if let Value::Int(n) = self { Some(*n) } else { None }
    }

    pub fn as_float(&self) -> Option<f64> {
        if let Value::Float(f) = self { Some(*f) } else { None }
    }

    pub fn as_str(&self) -> Option<&str> {
        if let Value::Str(s) = self { Some(s.as_str()) } else { None }
    }

    /// Compare two Values for ordering (used by query engine range ops).
    /// Returns None if the values are not comparable (different types).
    pub fn partial_cmp_numeric(&self, other: &Value) -> Option<std::cmp::Ordering> {
        match (self, other) {
            (Value::Int(a), Value::Int(b)) => a.partial_cmp(b),
            (Value::Float(a), Value::Float(b)) => a.partial_cmp(b),
            (Value::Int(a), Value::Float(b)) => (*a as f64).partial_cmp(b),
            (Value::Float(a), Value::Int(b)) => a.partial_cmp(&(*b as f64)),
            (Value::Str(a), Value::Str(b)) => a.partial_cmp(b),
            (Value::Bool(a), Value::Bool(b)) => a.partial_cmp(b),
            _ => None,
        }
    }
}

/// A database document with a ULID primary key and ordered fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: Ulid,
    pub fields: Vec<(String, Value)>,
}

impl Document {
    pub fn new(fields: Vec<(String, Value)>) -> Self {
        Document { id: new_ulid(), fields }
    }

    pub fn with_id(id: Ulid, fields: Vec<(String, Value)>) -> Self {
        Document { id, fields }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn set(&mut self, key: impl Into<String>, value: Value) {
        let key = key.into();
        if let Some(entry) = self.fields.iter_mut().find(|(k, _)| k == &key) {
            entry.1 = value;
        } else {
            self.fields.push((key, value));
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        if let Some(pos) = self.fields.iter().position(|(k, _)| k == key) {
            Some(self.fields.remove(pos).1)
        } else {
            None
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.fields.iter().any(|(k, _)| k == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_postcard() {
        let doc = Document::new(vec![
            ("name".into(), Value::Str("Alice".into())),
            ("age".into(), Value::Int(30)),
            ("active".into(), Value::Bool(true)),
            ("score".into(), Value::Float(9.5)),
            ("tags".into(), Value::Array(vec![Value::Str("rust".into()), Value::Str("db".into())])),
        ]);

        let bytes = postcard::to_allocvec(&doc).unwrap();
        let decoded: Document = postcard::from_bytes(&bytes).unwrap();

        assert_eq!(doc.id, decoded.id);
        assert_eq!(doc.fields, decoded.fields);
    }

    #[test]
    fn document_get_set_remove() {
        let mut doc = Document::new(vec![("x".into(), Value::Int(1))]);
        assert_eq!(doc.get("x"), Some(&Value::Int(1)));
        doc.set("x", Value::Int(2));
        assert_eq!(doc.get("x"), Some(&Value::Int(2)));
        doc.set("y", Value::Bool(true));
        assert_eq!(doc.get("y"), Some(&Value::Bool(true)));
        doc.remove("x");
        assert_eq!(doc.get("x"), None);
    }
}
