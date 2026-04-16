use napi_derive::napi;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use taladb_core::{
    Collection, Database, Filter, HnswOptions, HttpSyncHook, TalaDbConfig, TalaDbError, Update,
    Value, VectorMetric,
};

fn err_to_napi(e: TalaDbError) -> napi::Error {
    let code = match &e {
        TalaDbError::Storage(_) => "Storage",
        TalaDbError::Serialization(_) => "Serialization",
        TalaDbError::NotFound => "NotFound",
        TalaDbError::InvalidFilter(_) => "InvalidFilter",
        TalaDbError::IndexExists(_) => "IndexExists",
        TalaDbError::IndexNotFound(_) => "IndexNotFound",
        TalaDbError::Migration(_) => "Migration",
        TalaDbError::TypeError { .. } => "TypeError",
        TalaDbError::Encryption(_) => "Encryption",
        TalaDbError::WatchClosed => "WatchClosed",
        TalaDbError::WatchBackpressure => "WatchBackpressure",
        TalaDbError::InvalidSnapshot => "InvalidSnapshot",
        TalaDbError::VectorIndexNotFound(_) => "VectorIndexNotFound",
        TalaDbError::VectorDimensionMismatch { .. } => "VectorDimensionMismatch",
        TalaDbError::InvalidOperation(_) => "InvalidOperation",
        TalaDbError::Config(_) => "Config",
        TalaDbError::InvalidName(_) => "InvalidName",
        TalaDbError::QueryTimeout => "QueryTimeout",
    };
    napi::Error::from_reason(format!("{}: {}", code, e))
}

// ---------------------------------------------------------------------------
// Helpers: JSON ↔ taladb_core::Value
// ---------------------------------------------------------------------------

fn json_to_value(j: JsonValue) -> Value {
    match j {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Bool(b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else {
                Value::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        JsonValue::String(s) => Value::Str(s),
        JsonValue::Array(arr) => Value::Array(arr.into_iter().map(json_to_value).collect()),
        JsonValue::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, json_to_value(v)))
                .collect(),
        ),
    }
}

fn value_to_json(v: &Value) -> JsonValue {
    match v {
        Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Int(n) => JsonValue::Number((*n).into()),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Value::Str(s) => JsonValue::String(s.clone()),
        Value::Bytes(b) => JsonValue::String(format!("<bytes:{}>", b.len())),
        Value::Array(arr) => JsonValue::Array(arr.iter().map(value_to_json).collect()),
        Value::Object(obj) => JsonValue::Object(
            obj.iter()
                .map(|(k, v)| (k.clone(), value_to_json(v)))
                .collect(),
        ),
    }
}

fn doc_to_json(doc: &taladb_core::Document) -> JsonValue {
    let mut map = serde_json::Map::new();
    map.insert("_id".into(), JsonValue::String(doc.id.to_string()));
    for (k, v) in &doc.fields {
        map.insert(k.clone(), value_to_json(v));
    }
    JsonValue::Object(map)
}

fn obj_to_fields(json: JsonValue) -> napi::Result<Vec<(String, Value)>> {
    match json {
        JsonValue::Object(map) => Ok(map
            .into_iter()
            .map(|(k, v)| (k, json_to_value(v)))
            .collect()),
        _ => Err(napi::Error::from_reason("document must be a plain object")),
    }
}

fn json_to_filter(json: &JsonValue) -> napi::Result<Filter> {
    if json.is_null() {
        return Ok(Filter::All);
    }
    let obj = json
        .as_object()
        .ok_or_else(|| napi::Error::from_reason("filter must be an object"))?;

    if let Some(and_arr) = obj.get("$and") {
        let filters: napi::Result<Vec<Filter>> = and_arr
            .as_array()
            .ok_or_else(|| napi::Error::from_reason("$and must be an array"))?
            .iter()
            .map(json_to_filter)
            .collect();
        return Ok(Filter::And(filters?));
    }
    if let Some(or_arr) = obj.get("$or") {
        let filters: napi::Result<Vec<Filter>> = or_arr
            .as_array()
            .ok_or_else(|| napi::Error::from_reason("$or must be an array"))?
            .iter()
            .map(json_to_filter)
            .collect();
        return Ok(Filter::Or(filters?));
    }
    if let Some(not_obj) = obj.get("$not") {
        let inner = json_to_filter(not_obj)?;
        return Ok(Filter::Not(Box::new(inner)));
    }

    let mut filters = Vec::new();
    for (field, expr) in obj {
        let f = parse_field_filter(field, expr)?;
        filters.push(f);
    }

    match filters.len() {
        0 => Ok(Filter::All),
        1 => Ok(filters.remove(0)),
        _ => Ok(Filter::And(filters)),
    }
}

fn parse_field_filter(field: &str, expr: &JsonValue) -> napi::Result<Filter> {
    if !expr.is_object() {
        return Ok(Filter::Eq(field.to_string(), json_to_value(expr.clone())));
    }
    let ops = expr.as_object().unwrap();
    let mut filters = Vec::new();
    for (op, val) in ops {
        let v = json_to_value(val.clone());
        let f = match op.as_str() {
            "$eq" => Filter::Eq(field.to_string(), v),
            "$ne" => Filter::Ne(field.to_string(), v),
            "$gt" => Filter::Gt(field.to_string(), v),
            "$gte" => Filter::Gte(field.to_string(), v),
            "$lt" => Filter::Lt(field.to_string(), v),
            "$lte" => Filter::Lte(field.to_string(), v),
            "$in" => {
                let arr = val
                    .as_array()
                    .ok_or_else(|| napi::Error::from_reason("$in must be array"))?;
                Filter::In(
                    field.to_string(),
                    arr.iter().map(|v| json_to_value(v.clone())).collect(),
                )
            }
            "$nin" => {
                let arr = val
                    .as_array()
                    .ok_or_else(|| napi::Error::from_reason("$nin must be array"))?;
                Filter::Nin(
                    field.to_string(),
                    arr.iter().map(|v| json_to_value(v.clone())).collect(),
                )
            }
            "$exists" => Filter::Exists(field.to_string(), val.as_bool().unwrap_or(true)),
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "unknown operator: {}",
                    op
                )))
            }
        };
        filters.push(f);
    }
    match filters.len() {
        0 => Err(napi::Error::from_reason("empty field filter")),
        1 => Ok(filters.remove(0)),
        _ => Ok(Filter::And(filters)),
    }
}

fn json_to_update(json: JsonValue) -> napi::Result<Update> {
    let obj = json
        .as_object()
        .ok_or_else(|| napi::Error::from_reason("update must be an object"))?;

    if let Some(set_obj) = obj.get("$set") {
        let pairs = set_obj
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("$set must be an object"))?
            .iter()
            .map(|(k, v)| (k.clone(), json_to_value(v.clone())))
            .collect();
        return Ok(Update::Set(pairs));
    }
    if let Some(unset_obj) = obj.get("$unset") {
        let keys = unset_obj
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("$unset must be an object"))?
            .keys()
            .cloned()
            .collect();
        return Ok(Update::Unset(keys));
    }
    if let Some(inc_obj) = obj.get("$inc") {
        let pairs = inc_obj
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("$inc must be an object"))?
            .iter()
            .map(|(k, v)| (k.clone(), json_to_value(v.clone())))
            .collect();
        return Ok(Update::Inc(pairs));
    }
    if let Some(push_obj) = obj.get("$push") {
        let map = push_obj
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("$push must be an object"))?;
        let (k, v) = map
            .iter()
            .next()
            .ok_or_else(|| napi::Error::from_reason("$push needs one field"))?;
        return Ok(Update::Push(k.clone(), json_to_value(v.clone())));
    }
    if let Some(pull_obj) = obj.get("$pull") {
        let map = pull_obj
            .as_object()
            .ok_or_else(|| napi::Error::from_reason("$pull must be an object"))?;
        let (k, v) = map
            .iter()
            .next()
            .ok_or_else(|| napi::Error::from_reason("$pull needs one field"))?;
        return Ok(Update::Pull(k.clone(), json_to_value(v.clone())));
    }

    Err(napi::Error::from_reason("unsupported update operator"))
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

fn parse_metric(metric: Option<String>) -> napi::Result<Option<VectorMetric>> {
    match metric.as_deref() {
        None | Some("cosine") => Ok(Some(VectorMetric::Cosine)),
        Some("dot") => Ok(Some(VectorMetric::Dot)),
        Some("euclidean") => Ok(Some(VectorMetric::Euclidean)),
        Some(other) => Err(napi::Error::from_reason(format!(
            "unknown metric \"{other}\": expected \"cosine\", \"dot\", or \"euclidean\""
        ))),
    }
}

fn parse_hnsw_opts(
    index_type: Option<String>,
    m: Option<u32>,
    ef_construction: Option<u32>,
) -> Option<HnswOptions> {
    match index_type.as_deref() {
        Some("hnsw") => Some(HnswOptions {
            m: m.unwrap_or(16),
            ef_construction: ef_construction.unwrap_or(200),
        }),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// napi bindings
// ---------------------------------------------------------------------------

#[napi]
pub struct TalaDBNode {
    inner: Database,
    sync_hook: Option<Arc<dyn taladb_core::SyncHook>>,
}

#[napi]
impl TalaDBNode {
    /// Open an in-memory database (useful for testing).
    #[napi(factory)]
    pub fn open_in_memory() -> napi::Result<Self> {
        let db = Database::open_in_memory().map_err(err_to_napi)?;
        Ok(TalaDBNode {
            inner: db,
            sync_hook: None,
        })
    }

    /// Open a file-backed database at the given path.
    ///
    /// Pass an optional JSON-serialised `TalaDbConfig` as `config_json` to
    /// activate HTTP push sync. When `sync.enabled` is `true` and the
    /// `sync-http` feature is compiled in, an `HttpSyncHook` is attached to
    /// every collection returned by `collection()`.
    #[napi(factory)]
    pub fn open(path: String, config_json: Option<String>) -> napi::Result<Self> {
        let db = Database::open(std::path::Path::new(&path)).map_err(err_to_napi)?;
        let sync_hook = build_sync_hook(config_json)?;
        Ok(TalaDBNode {
            inner: db,
            sync_hook,
        })
    }

    /// Get a collection by name. If an HTTP sync hook is configured it is
    /// automatically attached to the returned collection.
    #[napi]
    pub fn collection(&self, name: String) -> napi::Result<CollectionNode> {
        let col = self.inner.collection(&name).map_err(err_to_napi)?;
        let col = match &self.sync_hook {
            Some(hook) => col.with_sync_hook(Arc::clone(hook)),
            None => col,
        };
        Ok(CollectionNode { inner: col })
    }
}

// ---------------------------------------------------------------------------
// Sync hook builder
// ---------------------------------------------------------------------------

/// Parse an optional JSON config string and build an `HttpSyncHook` when
/// `sync.enabled = true`. Returns `None` when config is absent or disabled.
fn build_sync_hook(
    config_json: Option<String>,
) -> napi::Result<Option<Arc<dyn taladb_core::SyncHook>>> {
    if let Some(json) = config_json {
        let config: TalaDbConfig = serde_json::from_str(&json)
            .map_err(|e| napi::Error::from_reason(format!("invalid config JSON: {e}")))?;
        config.validate().map_err(err_to_napi)?;
        if config.sync.enabled {
            let hook: Arc<dyn taladb_core::SyncHook> = Arc::new(HttpSyncHook::new(config.sync));
            return Ok(Some(hook));
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// CollectionNode
// ---------------------------------------------------------------------------

#[napi]
pub struct CollectionNode {
    inner: Collection,
}

#[napi]
impl CollectionNode {
    /// Insert a document. Returns the ULID string id.
    #[napi]
    pub fn insert(&self, doc: JsonValue) -> napi::Result<String> {
        let fields = obj_to_fields(doc)?;
        let id = self.inner.insert(fields).map_err(err_to_napi)?;
        Ok(id.to_string())
    }

    /// Insert multiple documents.
    #[napi(js_name = "insertMany")]
    pub fn insert_many(&self, docs: Vec<JsonValue>) -> napi::Result<Vec<String>> {
        let items: napi::Result<Vec<Vec<(String, Value)>>> =
            docs.into_iter().map(obj_to_fields).collect();
        let ids = self.inner.insert_many(items?).map_err(err_to_napi)?;
        Ok(ids.iter().map(|id| id.to_string()).collect())
    }

    /// Find documents matching the filter.
    #[napi]
    pub fn find(&self, filter: JsonValue) -> napi::Result<Vec<JsonValue>> {
        let f = json_to_filter(&filter)?;
        let docs = self.inner.find(f).map_err(err_to_napi)?;
        Ok(docs.iter().map(doc_to_json).collect())
    }

    /// Find a single document or return null.
    #[napi(js_name = "findOne")]
    pub fn find_one(&self, filter: JsonValue) -> napi::Result<Option<JsonValue>> {
        let f = json_to_filter(&filter)?;
        let doc = self.inner.find_one(f).map_err(err_to_napi)?;
        Ok(doc.map(|d| doc_to_json(&d)))
    }

    /// Update the first matching document.
    #[napi(js_name = "updateOne")]
    pub fn update_one(&self, filter: JsonValue, update: JsonValue) -> napi::Result<bool> {
        let f = json_to_filter(&filter)?;
        let u = json_to_update(update)?;
        self.inner.update_one(f, u).map_err(err_to_napi)
    }

    /// Update all matching documents.
    #[napi(js_name = "updateMany")]
    pub fn update_many(&self, filter: JsonValue, update: JsonValue) -> napi::Result<u32> {
        let f = json_to_filter(&filter)?;
        let u = json_to_update(update)?;
        let n = self.inner.update_many(f, u).map_err(err_to_napi)?;
        Ok(n as u32)
    }

    /// Delete the first matching document.
    #[napi(js_name = "deleteOne")]
    pub fn delete_one(&self, filter: JsonValue) -> napi::Result<bool> {
        let f = json_to_filter(&filter)?;
        self.inner.delete_one(f).map_err(err_to_napi)
    }

    /// Delete all matching documents.
    #[napi(js_name = "deleteMany")]
    pub fn delete_many(&self, filter: JsonValue) -> napi::Result<u32> {
        let f = json_to_filter(&filter)?;
        let n = self.inner.delete_many(f).map_err(err_to_napi)?;
        Ok(n as u32)
    }

    /// Count documents matching the filter.
    #[napi]
    pub fn count(&self, filter: JsonValue) -> napi::Result<u32> {
        let f = json_to_filter(&filter)?;
        let n = self.inner.count(f).map_err(err_to_napi)?;
        Ok(n as u32)
    }

    /// Create a secondary index on a field.
    #[napi(js_name = "createIndex")]
    pub fn create_index(&self, field: String) -> napi::Result<()> {
        self.inner.create_index(&field).map_err(err_to_napi)
    }

    /// Drop a secondary index.
    #[napi(js_name = "dropIndex")]
    pub fn drop_index(&self, field: String) -> napi::Result<()> {
        self.inner.drop_index(&field).map_err(err_to_napi)
    }

    /// Create a vector index on `field`.
    ///
    /// - `metric` — optional: `"cosine"` (default), `"dot"`, or `"euclidean"`.
    /// - `index_type` — optional: `"flat"` (default) or `"hnsw"`.
    /// - `hnsw_m` — HNSW connectivity (default 16).
    /// - `hnsw_ef_construction` — build quality (default 200).
    #[napi(js_name = "createVectorIndex")]
    pub fn create_vector_index(
        &self,
        field: String,
        dimensions: u32,
        metric: Option<String>,
        index_type: Option<String>,
        hnsw_m: Option<u32>,
        hnsw_ef_construction: Option<u32>,
    ) -> napi::Result<()> {
        let m = parse_metric(metric)?;
        let hnsw = parse_hnsw_opts(index_type, hnsw_m, hnsw_ef_construction);
        self.inner
            .create_vector_index(&field, dimensions as usize, m, hnsw)
            .map_err(err_to_napi)
    }

    /// Drop a vector index (and its HNSW graph if present).
    #[napi(js_name = "dropVectorIndex")]
    pub fn drop_vector_index(&self, field: String) -> napi::Result<()> {
        self.inner.drop_vector_index(&field).map_err(err_to_napi)
    }

    /// Rebuild the HNSW graph for a vector index from the current flat data.
    /// No-op when the feature is disabled or the index is flat-only.
    #[napi(js_name = "upgradeVectorIndex")]
    pub fn upgrade_vector_index(&self, field: String) -> napi::Result<()> {
        self.inner.upgrade_vector_index(&field).map_err(err_to_napi)
    }

    /// Find the `top_k` nearest documents to `query`.
    ///
    /// `filter` — optional pre-filter in the same JSON object format as `find`.
    ///
    /// Returns an array of `{ document: {...}, score: number }` objects.
    #[napi(js_name = "findNearest")]
    pub fn find_nearest(
        &self,
        field: String,
        query: Vec<f64>,
        top_k: u32,
        filter: Option<JsonValue>,
    ) -> napi::Result<Vec<JsonValue>> {
        let query_f32: Vec<f32> = query.iter().map(|&f| f as f32).collect();

        let pre_filter = match filter {
            Some(ref v) if !v.is_null() => Some(json_to_filter(v)?),
            _ => None,
        };

        let results = self
            .inner
            .find_nearest(&field, &query_f32, top_k as usize, pre_filter)
            .map_err(err_to_napi)?;

        Ok(results
            .iter()
            .map(|r| serde_json::json!({ "document": doc_to_json(&r.document), "score": r.score }))
            .collect())
    }
}
