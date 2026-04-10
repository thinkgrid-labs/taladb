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

use taladb_core::engine::RedbBackend;
use taladb_core::{Database, Filter, Update, Value, VectorMetric};

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
        let db = Database::open_in_memory().map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WorkerDB { db })
    }

    /// Open a database, restoring from a previously exported snapshot if provided.
    ///
    /// Pass the bytes returned by `WorkerDB.exportSnapshot()` (or `null`/`undefined`
    /// for a fresh empty database). Used by the IndexedDB fallback path.
    ///
    /// ```js
    /// const bytes = await idbLoadSnapshot(dbName);   // null on first open
    /// const workerDb = WorkerDB.openWithSnapshot(bytes);
    /// ```
    #[wasm_bindgen(js_name = openWithSnapshot)]
    pub fn open_with_snapshot(data: Option<Vec<u8>>) -> Result<WorkerDB, JsValue> {
        let db = match data {
            Some(ref bytes) if !bytes.is_empty() => Database::restore_from_snapshot(bytes)
                .map_err(|e| JsValue::from_str(&e.to_string()))?,
            _ => Database::open_in_memory().map_err(|e| JsValue::from_str(&e.to_string()))?,
        };
        Ok(WorkerDB { db })
    }

    /// Serialize the entire in-memory database to bytes for persistence.
    ///
    /// Pass the returned bytes to `idbSaveSnapshot` to persist across page reloads.
    /// On next open, pass the same bytes to `openWithSnapshot` to restore all data.
    #[wasm_bindgen(js_name = exportSnapshot)]
    pub fn export_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.db
            .export_snapshot()
            .map_err(|e| JsValue::from_str(&e.to_string()))
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
        let v: serde_json::Value =
            serde_json::from_str(doc_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let fields = json_obj_to_fields(&v)?;
        let col = self.db.collection(collection);
        let id = col
            .insert(fields)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(id.to_string())
    }

    /// Insert many documents. Returns a JSON array of ULID strings.
    #[wasm_bindgen(js_name = insertMany)]
    pub fn insert_many(&self, collection: &str, docs_json: &str) -> Result<String, JsValue> {
        let arr: Vec<serde_json::Value> =
            serde_json::from_str(docs_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let items: Result<Vec<_>, _> = arr.iter().map(json_obj_to_fields).collect();
        let col = self.db.collection(collection);
        let ids = col
            .insert_many(items?)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let id_strs: Vec<String> = ids.iter().map(|u| u.to_string()).collect();
        serde_json::to_string(&id_strs).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Find documents. Returns a JSON array of document objects.
    pub fn find(&self, collection: &str, filter_json: &str) -> Result<String, JsValue> {
        let filter = parse_filter(filter_json)?;
        let col = self.db.collection(collection);
        let docs = col
            .find(filter)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let json: Vec<serde_json::Value> = docs.iter().map(doc_to_json).collect();
        serde_json::to_string(&json).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Find one document. Returns a JSON object or `"null"`.
    #[wasm_bindgen(js_name = findOne)]
    pub fn find_one(&self, collection: &str, filter_json: &str) -> Result<String, JsValue> {
        let filter = parse_filter(filter_json)?;
        let col = self.db.collection(collection);
        let doc = col
            .find_one(filter)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let json = doc.as_ref().map(doc_to_json);
        serde_json::to_string(&json).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Update the first matching document. Returns `true` / `false`.
    #[wasm_bindgen(js_name = updateOne)]
    pub fn update_one(
        &self,
        collection: &str,
        filter_json: &str,
        update_json: &str,
    ) -> Result<bool, JsValue> {
        let filter = parse_filter(filter_json)?;
        let update = parse_update(update_json)?;
        self.db
            .collection(collection)
            .update_one(filter, update)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Update all matching documents. Returns the count updated.
    #[wasm_bindgen(js_name = updateMany)]
    pub fn update_many(
        &self,
        collection: &str,
        filter_json: &str,
        update_json: &str,
    ) -> Result<u32, JsValue> {
        let filter = parse_filter(filter_json)?;
        let update = parse_update(update_json)?;
        self.db
            .collection(collection)
            .update_many(filter, update)
            .map(|n| n as u32)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Delete the first matching document. Returns `true` / `false`.
    #[wasm_bindgen(js_name = deleteOne)]
    pub fn delete_one(&self, collection: &str, filter_json: &str) -> Result<bool, JsValue> {
        let filter = parse_filter(filter_json)?;
        self.db
            .collection(collection)
            .delete_one(filter)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Delete all matching documents. Returns the count deleted.
    #[wasm_bindgen(js_name = deleteMany)]
    pub fn delete_many(&self, collection: &str, filter_json: &str) -> Result<u32, JsValue> {
        let filter = parse_filter(filter_json)?;
        self.db
            .collection(collection)
            .delete_many(filter)
            .map(|n| n as u32)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Count matching documents.
    pub fn count(&self, collection: &str, filter_json: &str) -> Result<u32, JsValue> {
        let filter = parse_filter(filter_json)?;
        self.db
            .collection(collection)
            .count(filter)
            .map(|n| n as u32)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    // ------------------------------------------------------------------
    // Index management
    // ------------------------------------------------------------------

    #[wasm_bindgen(js_name = createIndex)]
    pub fn create_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db
            .collection(collection)
            .create_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = dropIndex)]
    pub fn drop_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db
            .collection(collection)
            .drop_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = createFtsIndex)]
    pub fn create_fts_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db
            .collection(collection)
            .create_fts_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = dropFtsIndex)]
    pub fn drop_fts_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db
            .collection(collection)
            .drop_fts_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Create a vector index. `metric_str`: `"cosine"` | `"dot"` | `"euclidean"` (default cosine).
    #[wasm_bindgen(js_name = createVectorIndex)]
    pub fn create_vector_index(
        &self,
        collection: &str,
        field: &str,
        dimensions: u32,
        metric_str: Option<String>,
    ) -> Result<(), JsValue> {
        let metric = parse_metric(metric_str)?;
        self.db
            .collection(collection)
            .create_vector_index(field, dimensions as usize, metric)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Drop a vector index.
    #[wasm_bindgen(js_name = dropVectorIndex)]
    pub fn drop_vector_index(&self, collection: &str, field: &str) -> Result<(), JsValue> {
        self.db
            .collection(collection)
            .drop_vector_index(field)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Find nearest neighbours. Returns a JSON string of `[{ document, score }]`.
    #[wasm_bindgen(js_name = findNearest)]
    pub fn find_nearest(
        &self,
        collection: &str,
        field: &str,
        query_json: &str,
        top_k: u32,
        filter_json: &str,
    ) -> Result<String, JsValue> {
        let query: Vec<f32> =
            serde_json::from_str(query_json).map_err(|e| JsValue::from_str(&e.to_string()))?;

        let pre_filter = if filter_json == "null" {
            None
        } else {
            let v: serde_json::Value =
                serde_json::from_str(filter_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            Some(json_to_filter_val(&v).ok_or_else(|| JsValue::from_str("invalid filter"))?)
        };

        let results = self
            .db
            .collection(collection)
            .find_nearest(field, &query, top_k as usize, pre_filter)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let json: Vec<serde_json::Value> = results
            .iter()
            .map(|r| serde_json::json!({ "document": doc_to_json(&r.document), "score": r.score }))
            .collect();

        serde_json::to_string(&json).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

fn parse_metric(metric: Option<String>) -> Result<Option<VectorMetric>, JsValue> {
    match metric.as_deref() {
        None | Some("cosine") => Ok(Some(VectorMetric::Cosine)),
        Some("dot") => Ok(Some(VectorMetric::Dot)),
        Some("euclidean") => Ok(Some(VectorMetric::Euclidean)),
        Some(other) => Err(JsValue::from_str(&format!(
            "unknown metric \"{other}\": expected \"cosine\", \"dot\", or \"euclidean\""
        ))),
    }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn json_obj_to_fields(v: &serde_json::Value) -> Result<Vec<(String, Value)>, JsValue> {
    match v {
        serde_json::Value::Object(map) => Ok(map
            .iter()
            .filter(|(k, _)| k.as_str() != "_id")
            .map(|(k, v)| (k.clone(), json_to_core_value(v)))
            .collect()),
        _ => Err(JsValue::from_str("document must be a JSON object")),
    }
}

fn parse_filter(json: &str) -> Result<Filter, JsValue> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if v.is_null() {
        return Ok(Filter::All);
    }
    json_to_filter_val(&v).ok_or_else(|| JsValue::from_str("invalid filter"))
}

fn parse_update(json: &str) -> Result<Update, JsValue> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    json_to_update_val(&v)
}

fn json_to_core_value(j: &serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else {
                Value::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Array(arr) => Value::Array(arr.iter().map(json_to_core_value).collect()),
        serde_json::Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), json_to_core_value(v)))
                .collect(),
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
                "$eq" => Filter::Eq(field.clone(), v),
                "$ne" => Filter::Ne(field.clone(), v),
                "$gt" => Filter::Gt(field.clone(), v),
                "$gte" => Filter::Gte(field.clone(), v),
                "$lt" => Filter::Lt(field.clone(), v),
                "$lte" => Filter::Lte(field.clone(), v),
                "$in" => Filter::In(
                    field.clone(),
                    val.as_array()?.iter().map(json_to_core_value).collect(),
                ),
                "$nin" => Filter::Nin(
                    field.clone(),
                    val.as_array()?.iter().map(json_to_core_value).collect(),
                ),
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
    let obj = v
        .as_object()
        .ok_or_else(|| JsValue::from_str("update must be an object"))?;

    if let Some(set) = obj.get("$set") {
        let pairs = set
            .as_object()
            .ok_or_else(|| JsValue::from_str("$set must be object"))?
            .iter()
            .map(|(k, v)| (k.clone(), json_to_core_value(v)))
            .collect();
        return Ok(Update::Set(pairs));
    }
    if let Some(unset) = obj.get("$unset") {
        let keys = unset
            .as_object()
            .ok_or_else(|| JsValue::from_str("$unset must be object"))?
            .keys()
            .cloned()
            .collect();
        return Ok(Update::Unset(keys));
    }
    if let Some(inc) = obj.get("$inc") {
        let pairs = inc
            .as_object()
            .ok_or_else(|| JsValue::from_str("$inc must be object"))?
            .iter()
            .map(|(k, v)| (k.clone(), json_to_core_value(v)))
            .collect();
        return Ok(Update::Inc(pairs));
    }
    if let Some(push) = obj.get("$push") {
        let map = push
            .as_object()
            .ok_or_else(|| JsValue::from_str("$push must be object"))?;
        let (k, v) = map
            .iter()
            .next()
            .ok_or_else(|| JsValue::from_str("$push needs one field"))?;
        return Ok(Update::Push(k.clone(), json_to_core_value(v)));
    }
    if let Some(pull) = obj.get("$pull") {
        let map = pull
            .as_object()
            .ok_or_else(|| JsValue::from_str("$pull must be object"))?;
        let (k, v) = map
            .iter()
            .next()
            .ok_or_else(|| JsValue::from_str("$pull needs one field"))?;
        return Ok(Update::Pull(k.clone(), json_to_core_value(v)));
    }

    Err(JsValue::from_str("unsupported update operator"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    // ------------------------------------------------------------------
    // WorkerDB::open_with_snapshot
    // ------------------------------------------------------------------

    #[wasm_bindgen_test]
    fn open_with_snapshot_none_produces_empty_db() {
        let db = WorkerDB::open_with_snapshot(None).unwrap();
        // A collection that was never written returns an empty JSON array.
        let result = db.find("items", "null").unwrap();
        assert_eq!(result, "[]");
    }

    #[wasm_bindgen_test]
    fn open_with_snapshot_empty_vec_treated_as_fresh_db() {
        // An empty Vec<u8> is equivalent to None — open fresh in-memory DB.
        let db = WorkerDB::open_with_snapshot(Some(vec![])).unwrap();
        let result = db.find("items", "null").unwrap();
        assert_eq!(result, "[]");
    }

    #[wasm_bindgen_test]
    fn open_with_snapshot_restores_documents() {
        // Build a DB, export its snapshot, restore into a new WorkerDB.
        let original = WorkerDB::open_with_snapshot(None).unwrap();
        original.insert("items", r#"{"name":"Alice"}"#).unwrap();
        original.insert("items", r#"{"name":"Bob"}"#).unwrap();

        let snapshot = original.export_snapshot().unwrap();

        let restored = WorkerDB::open_with_snapshot(Some(snapshot)).unwrap();
        let json = restored.find("items", "null").unwrap();
        let docs: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(docs.len(), 2);
        let names: Vec<&str> = docs.iter().filter_map(|d| d["name"].as_str()).collect();
        assert!(names.contains(&"Alice"));
        assert!(names.contains(&"Bob"));
    }

    #[wasm_bindgen_test]
    fn open_with_snapshot_restores_multiple_collections() {
        let original = WorkerDB::open_with_snapshot(None).unwrap();
        original.insert("users", r#"{"name":"Alice"}"#).unwrap();
        original.insert("posts", r#"{"title":"Hello"}"#).unwrap();
        original.insert("posts", r#"{"title":"World"}"#).unwrap();

        let snapshot = original.export_snapshot().unwrap();
        let restored = WorkerDB::open_with_snapshot(Some(snapshot)).unwrap();

        let users: Vec<serde_json::Value> =
            serde_json::from_str(&restored.find("users", "null").unwrap()).unwrap();
        let posts: Vec<serde_json::Value> =
            serde_json::from_str(&restored.find("posts", "null").unwrap()).unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(posts.len(), 2);
    }

    #[wasm_bindgen_test]
    fn open_with_snapshot_preserves_document_ids() {
        let original = WorkerDB::open_with_snapshot(None).unwrap();
        let id = original.insert("col", r#"{"x":42}"#).unwrap();

        let snapshot = original.export_snapshot().unwrap();
        let restored = WorkerDB::open_with_snapshot(Some(snapshot)).unwrap();

        let json = restored.find("col", "null").unwrap();
        let docs: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["_id"].as_str().unwrap(), id);
    }

    // ------------------------------------------------------------------
    // WorkerDB::export_snapshot
    // ------------------------------------------------------------------

    #[wasm_bindgen_test]
    fn export_snapshot_of_empty_db_starts_with_magic_bytes() {
        let db = WorkerDB::open_with_snapshot(None).unwrap();
        let bytes = db.export_snapshot().unwrap();
        // TalaDB snapshot magic: "TDBS"
        assert!(bytes.len() >= 4, "snapshot must be at least 4 bytes");
        assert_eq!(&bytes[..4], b"TDBS");
    }

    #[wasm_bindgen_test]
    fn export_snapshot_grows_after_inserts() {
        let db = WorkerDB::open_with_snapshot(None).unwrap();
        let empty_size = db.export_snapshot().unwrap().len();

        db.insert("col", r#"{"payload":"aaaaaaaaaa"}"#).unwrap();
        let after_insert = db.export_snapshot().unwrap().len();

        assert!(
            after_insert > empty_size,
            "snapshot must grow after inserting a document"
        );
    }

    #[wasm_bindgen_test]
    fn export_snapshot_twice_produces_equal_bytes_if_no_writes_in_between() {
        let db = WorkerDB::open_with_snapshot(None).unwrap();
        db.insert("col", r#"{"k":"v"}"#).unwrap();

        let snap1 = db.export_snapshot().unwrap();
        let snap2 = db.export_snapshot().unwrap();
        assert_eq!(snap1, snap2);
    }

    // ------------------------------------------------------------------
    // Round-trip — snapshot → restore → mutate → snapshot again
    // ------------------------------------------------------------------

    #[wasm_bindgen_test]
    fn snapshot_round_trip_then_further_inserts_are_visible() {
        // First generation
        let db1 = WorkerDB::open_with_snapshot(None).unwrap();
        db1.insert("items", r#"{"gen":1}"#).unwrap();
        let snap1 = db1.export_snapshot().unwrap();

        // Second generation — restore from snap1, add more data
        let db2 = WorkerDB::open_with_snapshot(Some(snap1)).unwrap();
        db2.insert("items", r#"{"gen":2}"#).unwrap();
        let snap2 = db2.export_snapshot().unwrap();

        // Third generation — must see both gen:1 and gen:2
        let db3 = WorkerDB::open_with_snapshot(Some(snap2)).unwrap();
        let json = db3.find("items", "null").unwrap();
        let docs: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(docs.len(), 2);
        let gens: Vec<i64> = docs.iter().filter_map(|d| d["gen"].as_i64()).collect();
        assert!(gens.contains(&1));
        assert!(gens.contains(&2));
    }

    #[wasm_bindgen_test]
    fn snapshot_round_trip_preserves_secondary_index() {
        let db = WorkerDB::open_with_snapshot(None).unwrap();
        db.create_index("users", "age").unwrap();
        db.insert("users", r#"{"age":30,"name":"Alice"}"#).unwrap();
        db.insert("users", r#"{"age":25,"name":"Bob"}"#).unwrap();

        let snap = db.export_snapshot().unwrap();
        let restored = WorkerDB::open_with_snapshot(Some(snap)).unwrap();

        // Filter via the indexed field
        let json = restored.find("users", r#"{"age":{"$eq":30}}"#).unwrap();
        let docs: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["name"].as_str().unwrap(), "Alice");
    }

    #[wasm_bindgen_test]
    fn snapshot_round_trip_update_delete_then_restore() {
        let db = WorkerDB::open_with_snapshot(None).unwrap();
        db.insert("col", r#"{"k":"keep"}"#).unwrap();
        db.insert("col", r#"{"k":"remove"}"#).unwrap();

        db.delete_one("col", r#"{"k":"remove"}"#).unwrap();
        db.update_one("col", r#"{"k":"keep"}"#, r#"{"$set":{"k":"updated"}}"#)
            .unwrap();

        let snap = db.export_snapshot().unwrap();
        let restored = WorkerDB::open_with_snapshot(Some(snap)).unwrap();

        let json = restored.find("col", "null").unwrap();
        let docs: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(
            docs.len(),
            1,
            "deleted document must not appear in snapshot"
        );
        assert_eq!(docs[0]["k"].as_str().unwrap(), "updated");
    }
}
