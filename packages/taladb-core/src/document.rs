use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use ulid::Ulid;
use web_time::{SystemTime, UNIX_EPOCH};

thread_local! {
    static PREV_MS: RefCell<u64> = const { RefCell::new(0) };
    static COUNTER: RefCell<u32> = const { RefCell::new(0) };
}

pub(crate) fn new_ulid_pub() -> Ulid { new_ulid() }

fn new_ulid() -> Ulid {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // Monotonic counter within the same millisecond keeps bulk inserts sortable.
    let seq = PREV_MS.with(|prev| {
        COUNTER.with(|cnt| {
            let mut p = prev.borrow_mut();
            let mut c = cnt.borrow_mut();
            if ms == *p { *c = c.wrapping_add(1); } else { *p = ms; *c = 0; }
            *c
        })
    });
    let mut buf = [0u8; 10]; // 80-bit random payload
    getrandom::fill(&mut buf).unwrap_or(());
    // Upper 16 bits of the random field = monotonic sequence; lower 64 bits = random.
    let rand_lo = u64::from_le_bytes(buf[..8].try_into().unwrap());
    let random = ((seq as u128) << 64) | (rand_lo as u128);
    Ulid::from_parts(ms, random)
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
        if let Value::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        if let Value::Int(n) = self {
            Some(*n)
        } else {
            None
        }
    }

    pub fn as_float(&self) -> Option<f64> {
        if let Value::Float(f) = self {
            Some(*f)
        } else {
            None
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        if let Value::Str(s) = self {
            Some(s.as_str())
        } else {
            None
        }
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
        Document {
            id: new_ulid(),
            fields,
        }
    }

    pub fn with_id(id: Ulid, fields: Vec<(String, Value)>) -> Self {
        Document { id, fields }
    }

    /// Return the value at `key`, supporting dot-notation for nested objects.
    ///
    /// `"name"` returns the top-level `name` field.
    /// `"address.city"` traverses into a nested `Value::Object`.
    /// Deep paths like `"a.b.c"` are resolved recursively.
    pub fn get(&self, key: &str) -> Option<&Value> {
        if let Some(dot) = key.find('.') {
            let (head, tail) = (&key[..dot], &key[dot + 1..]);
            let parent = self
                .fields
                .iter()
                .find(|(k, _)| k == head)
                .map(|(_, v)| v)?;
            value_get_nested(parent, tail)
        } else {
            self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        }
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
        self.get(key).is_some()
    }
}

/// Traverse a `Value::Object` using a dot-separated path.
pub fn value_get_nested<'a>(val: &'a Value, path: &str) -> Option<&'a Value> {
    if let Some(dot) = path.find('.') {
        let (head, tail) = (&path[..dot], &path[dot + 1..]);
        match val {
            Value::Object(fields) => {
                let child = fields.iter().find(|(k, _)| k == head).map(|(_, v)| v)?;
                value_get_nested(child, tail)
            }
            _ => None,
        }
    } else {
        match val {
            Value::Object(fields) => fields.iter().find(|(k, _)| k == path).map(|(_, v)| v),
            _ => None,
        }
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
            (
                "tags".into(),
                Value::Array(vec![Value::Str("rust".into()), Value::Str("db".into())]),
            ),
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
