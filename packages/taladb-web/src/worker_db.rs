//! WorkerDB — the WASM database handle that runs inside the SharedWorker.
//!
//! The SharedWorker (taladb.worker.js) loads the WASM module, calls
//! `WorkerDB::open_with_opfs(db_name, sync_handle)` once, then dispatches
//! every operation message to the synchronous methods below.
//!
//! All methods accept/return JSON strings so the JS worker script only needs
//! `JSON.stringify` / `JSON.parse` — no complex serialisation on the JS side.

use wasm_bindgen::prelude::*;
use web_sys::FileSystemSyncAccessHandle;

use taladb_core::{Database, Filter, Update, Value};
use taladb_core::engine::RedbBackend;

use crate::storage::opfs_backend::OpfsBackend;

use crate::doc_to_json;

// ---------------------------------------------------------------------------
// WorkerDB
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct WorkerDB {
    db: Database,
}

#[wasm_bindgen]
impl WorkerDB {
    // ------------------------------------------------------------------
    // Constructors
    // ------------------------------------------------------------------

    /// Open an in-memory database (for tests and OPFS-unavailable fallback).
    #[wasm_bindgen(js_name = openInMemory)]
    pub fn open_in_memory() -> Result<WorkerDB, JsValue> {
        let db = Database::open_in_memory()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WorkerDB { db })
    }

    /// Open a database backed by an OPFS `FileSystemSyncAccessHandle`.
    ///
    /// Call sequence in the SharedWorker:
    /// ```js
    /// const handle = await file_handle.createSyncAccessHandle();
    /// const workerDb = WorkerDB.openWithOpfs(handle);
    /// ```
    #[wasm_bindgen(js_name = openWithOpfs)]
    pub fn open_with_opfs(sync_handle: FileSystemSyncAccessHandle) -> Result<WorkerDB, JsValue> {
        let opfs = OpfsBackend::from_handle(sync_handle);
        let redb_backend = RedbBackend::open_with_redb_backend(opfs)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let db = Database::open_with_backend(Box::new(redb_backend))
            .map_err(|e: taladb_core::TalaDbError| JsValue::from_str(&e.to_string()))?;
        Ok(WorkerDB { db })
    }

    // ------------------------------------------------------------------
    // CRUD — all synchronous, accept/return JSON strings
    // ------------------------------------------------------------------

    /// Insert a document. Returns the new ULID as a string.
    pub fn insert(&self, collection: &str, doc_json: &str) -> Result<String, JsValue> {
        let v: serde_json::Value = serde_json::from_str(doc_json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let fields = json_obj_to_fields(&v)?;
        let col = self.db.collection(collection);
        let id = col.insert(fields)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(id.to_string())
    }

    /// Insert many documents. Returns a JSON array of ULID strings.
    #[wasm_bindgen(js_name = insertMany)]
    pub fn insert_many(&self, collection: &str, docs_json: &str) -> Result<String, JsValue> {
        let arr: Vec<serde_json::Value> = serde_json::from_str(docs_json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let items: Result<Vec<_>, _> = arr.iter().map(json_obj_to_fields).collect();
        let col = self.db.collection(collection);
        let ids = col.insert_many(items?)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let id_strs: Vec<String> = ids.iter().map(|u| u.to_string()).collect();
        serde_json::to_string(&id_strs)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Find documents. Returns a JSON array of document objects.
    pub fn find(&self, collection: &str, filter_json: &str) -> Result<String, JsValue> {
        let filter = parse_filter(filter_json)?;
        let col = self.db.collection(collection);
        let docs = col.find(filter)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let json: Vec<serde_json::Value> = docs.iter().map(doc_to_json).collect();
        serde_json::to_string(&json)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Find one document. Returns a JSON object or `"null"`.
    #[wasm_bindgen(js_name = findOne)]
    pub fn find_one(&self, collection: &str, filter_json: &str) -> Result<String, JsValue> {
        let filter = parse_filter(filter_json)?;
        let col = self.db.collection(collection);
        let doc = col.find_one(filter)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let json = doc.as_ref().map(doc_to_json);
        serde_json::to_string(&json)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Update the first matching document. Returns `true` / `false`.
    #[wasm_bindgen(js_name = updateOne)]
    pub fn update_one(
        &self, collection: &str, filter_json: &str, update_json: &str,
    ) -> Result<bool, JsValue> {
        let filter = parse_filter(filter_json)?;
        let update = parse_update(update_json)?;
        self.db.collection(collection)
            .update_one(filter, update)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Update all matching documents. Returns the count updated.
    #[wasm_bindgen(js_name = updateMany)]
    pub fn update_many(
        &self, collection: &str, filter_json: &str, update_json: &str,
    ) -> Result<u32, JsValue> {
        let filter = parse_filter(filter_json)?;
        let update = parse_update(update_json)?;
        self.db.collection(collection)
            .update_many(filter, update)
            .map(|n| n as u32)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Delete the first matching document. Returns `true` / `false`.
    #[wasm_bindgen(js_name = deleteOne)]
    pub fn delete_one(&self, collection: &str, filter_json: &str) -> Result<bool, JsValue> {
        let filter = parse_filter(filter_json)?;
        self.db.collection(collection)
            .delete_one(filter)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Delete all matching documents. Returns the count deleted.
    #[wasm_bindgen(js_name = deleteMany)]
    pub fn delete_many(&self, collection: &str, filter_json: &str) -> Result<u32, JsValue> {
        let filter = parse_filter(filter_json)?;
        self.db.collection(collection)
            .delete_many(filter)
            .map(|n| n as u32)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Count matching documents.
    pub fn count(&self, collection: &str, filter_json: &str) -> Result<u32, JsValue> {
        let filter = parse_filter(filter_json)?;
        self.db.collection(collection)
            .count(filter)
            .map(|n| n as u32)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    // ------------------------------------------------------------------
    // Index management
    // ------------------------------------------------------------------

    #[wasm_bindgen(js_name = createIndex)]
    pub fn create_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db.collection(collection)
            .create_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = dropIndex)]
    pub fn drop_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db.collection(collection)
            .drop_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = createFtsIndex)]
    pub fn create_fts_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db.collection(collection)
            .create_fts_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = dropFtsIndex)]
    pub fn drop_fts_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db.collection(collection)
            .drop_fts_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn json_obj_to_fields(v: &serde_json::Value) -> Result<Vec<(String, Value)>, JsValue> {
    match v {
        serde_json::Value::Object(map) => {
            Ok(map.iter()
                .filter(|(k, _)| k.as_str() != "_id")
                .map(|(k, v)| (k.clone(), json_to_core_value(v)))
                .collect())
        }
        _ => Err(JsValue::from_str("document must be a JSON object")),
    }
}

fn parse_filter(json: &str) -> Result<Filter, JsValue> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    if v.is_null() {
        return Ok(Filter::All);
    }
    json_to_filter_val(&v).ok_or_else(|| JsValue::from_str("invalid filter"))
}

fn parse_update(json: &str) -> Result<Update, JsValue> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    json_to_update_val(&v)
}

fn json_to_core_value(j: &serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() { Value::Int(i) }
            else { Value::Float(n.as_f64().unwrap_or(0.0)) }
        }
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Array(arr) => Value::Array(arr.iter().map(json_to_core_value).collect()),
        serde_json::Value::Object(map) => Value::Object(
            map.iter().map(|(k, v)| (k.clone(), json_to_core_value(v))).collect()
        ),
    }
}

fn json_to_filter_val(v: &serde_json::Value) -> Option<Filter> {
    let obj = v.as_object()?;

    if let Some(arr) = obj.get("$and") {
        let f: Option<Vec<Filter>> = arr.as_array()?.iter().map(json_to_filter_val).collect();
        return Some(Filter::And(f?));
    }
    if let Some(arr) = obj.get("$or") {
        let f: Option<Vec<Filter>> = arr.as_array()?.iter().map(json_to_filter_val).collect();
        return Some(Filter::Or(f?));
    }
    if let Some(inner) = obj.get("$not") {
        return Some(Filter::Not(Box::new(json_to_filter_val(inner)?)));
    }

    let mut filters: Vec<Filter> = Vec::new();
    for (field, expr) in obj {
        if !expr.is_object() {
            filters.push(Filter::Eq(field.clone(), json_to_core_value(expr)));
            continue;
        }
        let ops = expr.as_object()?;
        for (op, val) in ops {
            let v = json_to_core_value(val);
            let f = match op.as_str() {
                "$eq"  => Filter::Eq(field.clone(), v),
                "$ne"  => Filter::Ne(field.clone(), v),
                "$gt"  => Filter::Gt(field.clone(), v),
                "$gte" => Filter::Gte(field.clone(), v),
                "$lt"  => Filter::Lt(field.clone(), v),
                "$lte" => Filter::Lte(field.clone(), v),
                "$in"  => Filter::In(field.clone(), val.as_array()?.iter().map(json_to_core_value).collect()),
                "$nin" => Filter::Nin(field.clone(), val.as_array()?.iter().map(json_to_core_value).collect()),
                "$exists" => Filter::Exists(field.clone(), val.as_bool().unwrap_or(true)),
                _ => return None,
            };
            filters.push(f);
        }
    }
    match filters.len() {
        0 => Some(Filter::All),
        1 => Some(filters.remove(0)),
        _ => Some(Filter::And(filters)),
    }
}

fn json_to_update_val(v: &serde_json::Value) -> Result<Update, JsValue> {
    let obj = v.as_object().ok_or_else(|| JsValue::from_str("update must be an object"))?;

    if let Some(set) = obj.get("$set") {
        let pairs = set.as_object().ok_or_else(|| JsValue::from_str("$set must be object"))?
            .iter().map(|(k, v)| (k.clone(), json_to_core_value(v))).collect();
        return Ok(Update::Set(pairs));
    }
    if let Some(unset) = obj.get("$unset") {
        let keys = unset.as_object().ok_or_else(|| JsValue::from_str("$unset must be object"))?
            .keys().cloned().collect();
        return Ok(Update::Unset(keys));
    }
    if let Some(inc) = obj.get("$inc") {
        let pairs = inc.as_object().ok_or_else(|| JsValue::from_str("$inc must be object"))?
            .iter().map(|(k, v)| (k.clone(), json_to_core_value(v))).collect();
        return Ok(Update::Inc(pairs));
    }
    if let Some(push) = obj.get("$push") {
        let map = push.as_object().ok_or_else(|| JsValue::from_str("$push must be object"))?;
        let (k, v) = map.iter().next().ok_or_else(|| JsValue::from_str("$push needs one field"))?;
        return Ok(Update::Push(k.clone(), json_to_core_value(v)));
    }
    if let Some(pull) = obj.get("$pull") {
        let map = pull.as_object().ok_or_else(|| JsValue::from_str("$pull must be object"))?;
        let (k, v) = map.iter().next().ok_or_else(|| JsValue::from_str("$pull needs one field"))?;
        return Ok(Update::Pull(k.clone(), json_to_core_value(v)));
    }

    Err(JsValue::from_str("unsupported update operator"))
}
