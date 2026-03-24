mod storage;

use std::sync::Arc;

use serde_wasm_bindgen::{from_value, to_value};
use wasm_bindgen::prelude::*;
use zerodb_core::{Collection, Database, Filter, Update, Value};

pub use storage::opfs::is_opfs_available;

/// Initialize panic hook for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

// ---------------------------------------------------------------------------
// ZeroDBWasm — the top-level database handle exposed to JavaScript
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct ZeroDBWasm {
    inner: Arc<Database>,
}

#[wasm_bindgen]
impl ZeroDBWasm {
    /// Open an in-memory database (suitable for tests and environments without OPFS).
    #[wasm_bindgen(js_name = openInMemory)]
    pub fn open_in_memory() -> Result<ZeroDBWasm, JsValue> {
        let db = Database::open_in_memory().map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(ZeroDBWasm { inner: Arc::new(db) })
    }

    /// Get a collection handle by name.
    pub fn collection(&self, name: &str) -> CollectionWasm {
        let col = self.inner.collection(name);
        CollectionWasm { inner: col }
    }
}

// ---------------------------------------------------------------------------
// CollectionWasm — exposes insert/find/update/delete to JavaScript
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct CollectionWasm {
    inner: Collection,
}

#[wasm_bindgen]
impl CollectionWasm {
    /// Insert a document. Accepts a plain JS object, returns the ULID string id.
    pub fn insert(&self, doc: JsValue) -> Result<String, JsValue> {
        let fields = js_object_to_fields(doc)?;
        let id = self.inner.insert(fields).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(id.to_string())
    }

    /// Insert multiple documents. Returns an array of ULID string ids.
    #[wasm_bindgen(js_name = insertMany)]
    pub fn insert_many(&self, docs: JsValue) -> Result<JsValue, JsValue> {
        let arr = js_sys::Array::from(&docs);
        let items: Result<Vec<Vec<(String, Value)>>, JsValue> =
            arr.iter().map(js_object_to_fields).collect();
        let ids = self
            .inner
            .insert_many(items?)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let id_strings: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
        to_value(&id_strings).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Find documents matching the filter. Returns a JS array of plain objects.
    pub fn find(&self, filter: JsValue) -> Result<JsValue, JsValue> {
        let f = js_to_filter(filter)?;
        let docs = self.inner.find(f).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let result: Vec<serde_json::Value> = docs.iter().map(doc_to_json).collect();
        to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Find a single document. Returns the document or null.
    #[wasm_bindgen(js_name = findOne)]
    pub fn find_one(&self, filter: JsValue) -> Result<JsValue, JsValue> {
        let f = js_to_filter(filter)?;
        match self.inner.find_one(f).map_err(|e| JsValue::from_str(&e.to_string()))? {
            Some(doc) => {
                let json = doc_to_json(&doc);
                to_value(&json).map_err(|e| JsValue::from_str(&e.to_string()))
            }
            None => Ok(JsValue::NULL),
        }
    }

    /// Update the first matching document. Returns true if a document was updated.
    #[wasm_bindgen(js_name = updateOne)]
    pub fn update_one(&self, filter: JsValue, update: JsValue) -> Result<bool, JsValue> {
        let f = js_to_filter(filter)?;
        let u = js_to_update(update)?;
        self.inner.update_one(f, u).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Update all matching documents. Returns the count updated.
    #[wasm_bindgen(js_name = updateMany)]
    pub fn update_many(&self, filter: JsValue, update: JsValue) -> Result<u32, JsValue> {
        let f = js_to_filter(filter)?;
        let u = js_to_update(update)?;
        let n = self.inner.update_many(f, u).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(n as u32)
    }

    /// Delete the first matching document. Returns true if deleted.
    #[wasm_bindgen(js_name = deleteOne)]
    pub fn delete_one(&self, filter: JsValue) -> Result<bool, JsValue> {
        let f = js_to_filter(filter)?;
        self.inner.delete_one(f).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Delete all matching documents. Returns the count deleted.
    #[wasm_bindgen(js_name = deleteMany)]
    pub fn delete_many(&self, filter: JsValue) -> Result<u32, JsValue> {
        let f = js_to_filter(filter)?;
        let n = self.inner.delete_many(f).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(n as u32)
    }

    /// Count documents matching the filter.
    pub fn count(&self, filter: JsValue) -> Result<u32, JsValue> {
        let f = js_to_filter(filter)?;
        let n = self.inner.count(f).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(n as u32)
    }

    /// Create a secondary index on a field.
    #[wasm_bindgen(js_name = createIndex)]
    pub fn create_index(&self, field: &str) -> Result<(), JsValue> {
        self.inner.create_index(field).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Drop a secondary index.
    #[wasm_bindgen(js_name = dropIndex)]
    pub fn drop_index(&self, field: &str) -> Result<(), JsValue> {
        self.inner.drop_index(field).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Conversion helpers: JS ↔ Rust
// ---------------------------------------------------------------------------

/// Convert a JS object like { name: "Alice", age: 30 } to Vec<(String, Value)>.
fn js_object_to_fields(val: JsValue) -> Result<Vec<(String, Value)>, JsValue> {
    let json: serde_json::Value =
        from_value(val).map_err(|e| JsValue::from_str(&e.to_string()))?;
    match json {
        serde_json::Value::Object(map) => {
            Ok(map.into_iter().map(|(k, v)| (k, json_to_value(v))).collect())
        }
        _ => Err(JsValue::from_str("document must be a plain object")),
    }
}

fn json_to_value(j: serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else {
                Value::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => Value::Str(s),
        serde_json::Value::Array(arr) => Value::Array(arr.into_iter().map(json_to_value).collect()),
        serde_json::Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, json_to_value(v))).collect())
        }
    }
}

fn value_to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => serde_json::Value::Bool(*b),
        Value::Int(n) => serde_json::Value::Number((*n).into()),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Str(s) => serde_json::Value::String(s.clone()),
        Value::Bytes(b) => serde_json::Value::String(format!("<bytes:{}>", b.len())),
        Value::Array(arr) => serde_json::Value::Array(arr.iter().map(value_to_json).collect()),
        Value::Object(obj) => serde_json::Value::Object(
            obj.iter().map(|(k, v)| (k.clone(), value_to_json(v))).collect(),
        ),
    }
}

fn doc_to_json(doc: &zerodb_core::Document) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("_id".into(), serde_json::Value::String(doc.id.to_string()));
    for (k, v) in &doc.fields {
        map.insert(k.clone(), value_to_json(v));
    }
    serde_json::Value::Object(map)
}

/// Convert a JS filter object to a Rust Filter.
/// Supports: { field: value }  →  Eq
///           { field: { $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists } }
///           { $and: [...] }, { $or: [...] }, { $not: { ... } }
fn js_to_filter(val: JsValue) -> Result<Filter, JsValue> {
    if val.is_null() || val.is_undefined() {
        return Ok(Filter::All);
    }
    let json: serde_json::Value =
        from_value(val).map_err(|e| JsValue::from_str(&e.to_string()))?;
    json_to_filter(&json)
        .ok_or_else(|| JsValue::from_str("invalid filter"))
}

fn json_to_filter(json: &serde_json::Value) -> Option<Filter> {
    let obj = json.as_object()?;

    // Logical operators
    if let Some(and_arr) = obj.get("$and") {
        let filters: Option<Vec<Filter>> = and_arr.as_array()?.iter().map(json_to_filter).collect();
        return Some(Filter::And(filters?));
    }
    if let Some(or_arr) = obj.get("$or") {
        let filters: Option<Vec<Filter>> = or_arr.as_array()?.iter().map(json_to_filter).collect();
        return Some(Filter::Or(filters?));
    }
    if let Some(not_obj) = obj.get("$not") {
        let inner = json_to_filter(not_obj)?;
        return Some(Filter::Not(Box::new(inner)));
    }

    // Field-level operators
    let mut filters: Vec<Filter> = Vec::new();
    for (field, expr) in obj {
        let f = parse_field_filter(field, expr)?;
        filters.push(f);
    }

    match filters.len() {
        0 => Some(Filter::All),
        1 => Some(filters.remove(0)),
        _ => Some(Filter::And(filters)),
    }
}

fn parse_field_filter(field: &str, expr: &serde_json::Value) -> Option<Filter> {
    // Simple equality: { age: 30 }
    if !expr.is_object() {
        return Some(Filter::Eq(field.to_string(), json_to_value(expr.clone())));
    }

    let ops = expr.as_object()?;
    let mut filters = Vec::new();

    for (op, val) in ops {
        let v = json_to_value(val.clone());
        let f = match op.as_str() {
            "$eq"  => Filter::Eq(field.to_string(), v),
            "$ne"  => Filter::Ne(field.to_string(), v),
            "$gt"  => Filter::Gt(field.to_string(), v),
            "$gte" => Filter::Gte(field.to_string(), v),
            "$lt"  => Filter::Lt(field.to_string(), v),
            "$lte" => Filter::Lte(field.to_string(), v),
            "$in"  => {
                let arr = val.as_array()?.iter().map(|v| json_to_value(v.clone())).collect();
                Filter::In(field.to_string(), arr)
            }
            "$nin" => {
                let arr = val.as_array()?.iter().map(|v| json_to_value(v.clone())).collect();
                Filter::Nin(field.to_string(), arr)
            }
            "$exists" => Filter::Exists(field.to_string(), val.as_bool().unwrap_or(true)),
            _ => return None,
        };
        filters.push(f);
    }

    match filters.len() {
        0 => None,
        1 => Some(filters.remove(0)),
        _ => Some(Filter::And(filters)),
    }
}

/// Convert a JS update object to a Rust Update.
/// Supports: { $set: {...} }, { $unset: {...} }, { $inc: {...} },
///           { $push: { field: val } }, { $pull: { field: val } }
fn js_to_update(val: JsValue) -> Result<Update, JsValue> {
    let json: serde_json::Value =
        from_value(val).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let obj = json.as_object().ok_or_else(|| JsValue::from_str("update must be an object"))?;

    if let Some(set_obj) = obj.get("$set") {
        let pairs = set_obj.as_object()
            .ok_or_else(|| JsValue::from_str("$set must be an object"))?
            .iter()
            .map(|(k, v)| (k.clone(), json_to_value(v.clone())))
            .collect();
        return Ok(Update::Set(pairs));
    }
    if let Some(unset_obj) = obj.get("$unset") {
        let keys = unset_obj.as_object()
            .ok_or_else(|| JsValue::from_str("$unset must be an object"))?
            .keys()
            .cloned()
            .collect();
        return Ok(Update::Unset(keys));
    }
    if let Some(inc_obj) = obj.get("$inc") {
        let pairs = inc_obj.as_object()
            .ok_or_else(|| JsValue::from_str("$inc must be an object"))?
            .iter()
            .map(|(k, v)| (k.clone(), json_to_value(v.clone())))
            .collect();
        return Ok(Update::Inc(pairs));
    }
    if let Some(push_obj) = obj.get("$push") {
        let map = push_obj.as_object()
            .ok_or_else(|| JsValue::from_str("$push must be an object"))?;
        let (k, v) = map.iter().next()
            .ok_or_else(|| JsValue::from_str("$push needs one field"))?;
        return Ok(Update::Push(k.clone(), json_to_value(v.clone())));
    }
    if let Some(pull_obj) = obj.get("$pull") {
        let map = pull_obj.as_object()
            .ok_or_else(|| JsValue::from_str("$pull must be an object"))?;
        let (k, v) = map.iter().next()
            .ok_or_else(|| JsValue::from_str("$pull needs one field"))?;
        return Ok(Update::Pull(k.clone(), json_to_value(v.clone())));
    }

    Err(JsValue::from_str("unsupported update operator"))
}

// ---------------------------------------------------------------------------
// WASM tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use wasm_bindgen_test::*;
    use super::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    fn in_memory_insert_find() {
        let db = ZeroDBWasm::open_in_memory().unwrap();
        let col = db.collection("users");

        let doc = js_sys::Object::new();
        js_sys::Reflect::set(&doc, &"name".into(), &"Alice".into()).unwrap();
        js_sys::Reflect::set(&doc, &"age".into(), &JsValue::from_f64(30.0)).unwrap();

        let id = col.insert(doc.into()).unwrap();
        assert!(!id.is_empty());

        let results = col.find(JsValue::NULL).unwrap();
        let arr = js_sys::Array::from(&results);
        assert_eq!(arr.length(), 1);
    }
}
