//! TalaDB C FFI layer for React Native JSI.
//!
//! All functions at this boundary follow these conventions:
//!
//! - Strings in : `*const c_char` — UTF-8, null-terminated, caller-owned.
//! - Strings out: `*mut c_char` — UTF-8, null-terminated, heap-allocated;
//!   **caller must free with `taladb_free_string`**.
//! - Handles: `*mut TalaDbHandle` — opaque pointer; create with
//!   `taladb_open`, destroy with `taladb_close`.
//! - Errors: string functions return `NULL` on error;
//!   integer functions return `-1` on error.
//!
//! JSON is used at every boundary so the C++ HostObject only needs
//! `JSON.stringify` / `JSON.parse` — no complex serialisation.
//!
//! # Safety
//!
//! All exported functions follow these invariants:
//! - Raw pointer arguments must be either null or point to valid, aligned,
//!   live memory for the duration of the call.
//! - `*const c_char` arguments must be null-terminated UTF-8 C strings.
//! - `*mut TalaDbHandle` must have been obtained from `taladb_open` and not
//!   yet passed to `taladb_close`.
//! - `*mut c_char` return values must be freed with `taladb_free_string`.

// Safety contract is documented at the module level above.
#![allow(clippy::missing_safety_doc)]

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;

use taladb_core::{Database, Filter, Update, Value};

// ---------------------------------------------------------------------------
// Opaque database handle
// ---------------------------------------------------------------------------

pub struct TalaDbHandle {
    db: Database,
}

// ---------------------------------------------------------------------------
// Open / Close
// ---------------------------------------------------------------------------

/// Open (or create) a TalaDB database at `path`.
///
/// Returns an opaque handle, or NULL on failure.
/// The handle must be freed with `taladb_close`.
#[no_mangle]
pub unsafe extern "C" fn taladb_open(path: *const c_char) -> *mut TalaDbHandle {
    let path_str = match unsafe { CStr::from_ptr(path) }.to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    match Database::open(Path::new(path_str)) {
        Ok(db) => Box::into_raw(Box::new(TalaDbHandle { db })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Close the database and free the handle.
#[no_mangle]
pub unsafe extern "C" fn taladb_close(handle: *mut TalaDbHandle) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle) });
    }
}

/// Free a string returned by any taladb_* function.
#[no_mangle]
pub unsafe extern "C" fn taladb_free_string(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/// Insert a document (JSON object string).
/// Returns the new document's ULID as a C string, or NULL on error.
/// Caller must free the returned string with `taladb_free_string`.
#[no_mangle]
pub unsafe extern "C" fn taladb_insert(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    doc_json: *const c_char,
) -> *mut c_char {
    let (db, col_name, json) = match parse_args(handle, collection, doc_json) {
        Some(t) => t,
        None => return std::ptr::null_mut(),
    };
    let fields = match json_to_fields(&json) {
        Some(f) => f,
        None => return std::ptr::null_mut(),
    };
    match db.collection(&col_name).insert(fields) {
        Ok(id) => to_cstring(id.to_string()),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Insert multiple documents (JSON array of objects).
/// Returns a JSON array of ULID strings, or NULL on error.
/// Caller must free with `taladb_free_string`.
#[no_mangle]
pub unsafe extern "C" fn taladb_insert_many(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    docs_json: *const c_char,
) -> *mut c_char {
    let (db, col_name, json) = match parse_args(handle, collection, docs_json) {
        Some(t) => t,
        None => return std::ptr::null_mut(),
    };
    let arr = match serde_json::from_str::<Vec<serde_json::Value>>(&json) {
        Ok(v) => v,
        Err(_) => return std::ptr::null_mut(),
    };
    let items: Vec<Vec<(String, Value)>> = arr.iter()
        .filter_map(|v| json_to_fields(&v.to_string()))
        .collect();
    match db.collection(&col_name).insert_many(items) {
        Ok(ids) => {
            let id_strs: Vec<String> = ids.iter().map(|u| u.to_string()).collect();
            to_cstring(serde_json::to_string(&id_strs).unwrap_or_default())
        }
        Err(_) => std::ptr::null_mut(),
    }
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

/// Find all documents matching `filter_json`.
/// Pass `"{}"` or `"null"` to match all.
/// Returns a JSON array string, or NULL on error.
/// Caller must free with `taladb_free_string`.
#[no_mangle]
pub unsafe extern "C" fn taladb_find(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    filter_json: *const c_char,
) -> *mut c_char {
    let (db, col_name, json) = match parse_args(handle, collection, filter_json) {
        Some(t) => t,
        None => return std::ptr::null_mut(),
    };
    let filter = parse_filter(&json);
    match db.collection(&col_name).find(filter) {
        Ok(docs) => {
            let json_docs: Vec<serde_json::Value> = docs.iter().map(doc_to_json).collect();
            to_cstring(serde_json::to_string(&json_docs).unwrap_or_default())
        }
        Err(_) => std::ptr::null_mut(),
    }
}

/// Find one document matching `filter_json`, or JSON `null` if none.
/// Caller must free with `taladb_free_string`.
#[no_mangle]
pub unsafe extern "C" fn taladb_find_one(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    filter_json: *const c_char,
) -> *mut c_char {
    let (db, col_name, json) = match parse_args(handle, collection, filter_json) {
        Some(t) => t,
        None => return std::ptr::null_mut(),
    };
    let filter = parse_filter(&json);
    match db.collection(&col_name).find_one(filter) {
        Ok(Some(doc)) => to_cstring(doc_to_json(&doc).to_string()),
        Ok(None) => to_cstring("null".to_string()),
        Err(_) => std::ptr::null_mut(),
    }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/// Update the first matching document.
/// Returns 1 if updated, 0 if not found, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn taladb_update_one(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    filter_json: *const c_char,
    update_json: *const c_char,
) -> i32 {
    let handle = ptr_to_ref(handle);
    let col_name = cstr_to_string(collection);
    let filter_str = cstr_to_string(filter_json);
    let update_str = cstr_to_string(update_json);
    match (handle, col_name, filter_str, update_str) {
        (Some(h), Some(col), Some(fs), Some(us)) => {
            let filter = parse_filter(&fs);
            match parse_update(&us) {
                Some(update) => match h.db.collection(&col).update_one(filter, update) {
                    Ok(true) => 1,
                    Ok(false) => 0,
                    Err(_) => -1,
                },
                None => -1,
            }
        }
        _ => -1,
    }
}

/// Update all matching documents.
/// Returns count updated, or -1 on error.
#[no_mangle]
pub unsafe extern "C" fn taladb_update_many(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    filter_json: *const c_char,
    update_json: *const c_char,
) -> i32 {
    let handle = ptr_to_ref(handle);
    let col_name = cstr_to_string(collection);
    let filter_str = cstr_to_string(filter_json);
    let update_str = cstr_to_string(update_json);
    match (handle, col_name, filter_str, update_str) {
        (Some(h), Some(col), Some(fs), Some(us)) => {
            let filter = parse_filter(&fs);
            match parse_update(&us) {
                Some(update) => match h.db.collection(&col).update_many(filter, update) {
                    Ok(n) => n as i32,
                    Err(_) => -1,
                },
                None => -1,
            }
        }
        _ => -1,
    }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/// Delete the first matching document.
/// Returns 1 if deleted, 0 if not found, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn taladb_delete_one(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    filter_json: *const c_char,
) -> i32 {
    let (db, col_name, json) = match parse_args(handle, collection, filter_json) {
        Some(t) => t,
        None => return -1,
    };
    match db.collection(&col_name).delete_one(parse_filter(&json)) {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(_) => -1,
    }
}

/// Delete all matching documents.
/// Returns count deleted, or -1 on error.
#[no_mangle]
pub unsafe extern "C" fn taladb_delete_many(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    filter_json: *const c_char,
) -> i32 {
    let (db, col_name, json) = match parse_args(handle, collection, filter_json) {
        Some(t) => t,
        None => return -1,
    };
    match db.collection(&col_name).delete_many(parse_filter(&json)) {
        Ok(n) => n as i32,
        Err(_) => -1,
    }
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

/// Count documents matching `filter_json`.
/// Returns count, or -1 on error.
#[no_mangle]
pub unsafe extern "C" fn taladb_count(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    filter_json: *const c_char,
) -> i32 {
    let (db, col_name, json) = match parse_args(handle, collection, filter_json) {
        Some(t) => t,
        None => return -1,
    };
    match db.collection(&col_name).count(parse_filter(&json)) {
        Ok(n) => n as i32,
        Err(_) => -1,
    }
}

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

/// Create a secondary index on `field`. No-op if already exists.
#[no_mangle]
pub unsafe extern "C" fn taladb_create_index(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    field: *const c_char,
) {
    if let (Some(h), Some(col), Some(f)) =
        (ptr_to_ref(handle), cstr_to_string(collection), cstr_to_string(field))
    {
        let _ = h.db.collection(&col).create_index(&f);
    }
}

/// Drop a secondary index on `field`.
#[no_mangle]
pub unsafe extern "C" fn taladb_drop_index(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    field: *const c_char,
) {
    if let (Some(h), Some(col), Some(f)) =
        (ptr_to_ref(handle), cstr_to_string(collection), cstr_to_string(field))
    {
        let _ = h.db.collection(&col).drop_index(&f);
    }
}

/// Create a full-text search index on `field`.
#[no_mangle]
pub unsafe extern "C" fn taladb_create_fts_index(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    field: *const c_char,
) {
    if let (Some(h), Some(col), Some(f)) =
        (ptr_to_ref(handle), cstr_to_string(collection), cstr_to_string(field))
    {
        let _ = h.db.collection(&col).create_fts_index(&f);
    }
}

/// Drop a full-text search index on `field`.
#[no_mangle]
pub unsafe extern "C" fn taladb_drop_fts_index(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    field: *const c_char,
) {
    if let (Some(h), Some(col), Some(f)) =
        (ptr_to_ref(handle), cstr_to_string(collection), cstr_to_string(field))
    {
        let _ = h.db.collection(&col).drop_fts_index(&f);
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn ptr_to_ref<'a>(handle: *mut TalaDbHandle) -> Option<&'a TalaDbHandle> {
    if handle.is_null() { None } else { Some(unsafe { &*handle }) }
}

fn cstr_to_string(s: *const c_char) -> Option<String> {
    if s.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(s) }.to_str().ok().map(str::to_owned)
}

fn to_cstring(s: String) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Convenience: validate handle + parse two C string args.
/// Returns a reference to the inner `Database` (not the wrapper) for ergonomic use.
fn parse_args<'a>(
    handle: *mut TalaDbHandle,
    collection: *const c_char,
    extra: *const c_char,
) -> Option<(&'a taladb_core::Database, String, String)> {
    Some((&ptr_to_ref(handle)?.db, cstr_to_string(collection)?, cstr_to_string(extra)?))
}

// ---------------------------------------------------------------------------
// JSON ↔ taladb-core type converters
// ---------------------------------------------------------------------------

fn json_to_value(j: &serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() { Value::Int(i) }
            else { Value::Float(n.as_f64().unwrap_or(0.0)) }
        }
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Array(arr) => Value::Array(arr.iter().map(json_to_value).collect()),
        serde_json::Value::Object(map) => Value::Object(
            map.iter().map(|(k, v)| (k.clone(), json_to_value(v))).collect(),
        ),
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

fn doc_to_json(doc: &taladb_core::Document) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("_id".to_string(), serde_json::Value::String(doc.id.to_string()));
    for (k, v) in &doc.fields {
        map.insert(k.clone(), value_to_json(v));
    }
    serde_json::Value::Object(map)
}

fn json_to_fields(json: &str) -> Option<Vec<(String, Value)>> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let obj = v.as_object()?;
    Some(
        obj.iter()
            .filter(|(k, _)| k.as_str() != "_id")
            .map(|(k, v)| (k.clone(), json_to_value(v)))
            .collect(),
    )
}

fn parse_filter(json: &str) -> Filter {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
    if v.is_null() || (v.is_object() && v.as_object().is_some_and(|m| m.is_empty())) {
        return Filter::All;
    }
    json_to_filter(&v).unwrap_or(Filter::All)
}

fn json_to_filter(v: &serde_json::Value) -> Option<Filter> {
    let obj = v.as_object()?;
    if let Some(arr) = obj.get("$and") {
        let filters: Option<Vec<Filter>> = arr.as_array()?.iter().map(json_to_filter).collect();
        return Some(Filter::And(filters?));
    }
    if let Some(arr) = obj.get("$or") {
        let filters: Option<Vec<Filter>> = arr.as_array()?.iter().map(json_to_filter).collect();
        return Some(Filter::Or(filters?));
    }
    if let Some(inner) = obj.get("$not") {
        return Some(Filter::Not(Box::new(json_to_filter(inner)?)));
    }
    let mut filters: Vec<Filter> = Vec::new();
    for (field, expr) in obj {
        if !expr.is_object() {
            filters.push(Filter::Eq(field.clone(), json_to_value(expr)));
            continue;
        }
        let ops = expr.as_object()?;
        for (op, val) in ops {
            let v = json_to_value(val);
            let f = match op.as_str() {
                "$eq"     => Filter::Eq(field.clone(), v),
                "$ne"     => Filter::Ne(field.clone(), v),
                "$gt"     => Filter::Gt(field.clone(), v),
                "$gte"    => Filter::Gte(field.clone(), v),
                "$lt"     => Filter::Lt(field.clone(), v),
                "$lte"    => Filter::Lte(field.clone(), v),
                "$exists" => Filter::Exists(field.clone(), val.as_bool().unwrap_or(true)),
                "$in"     => Filter::In(
                    field.clone(),
                    val.as_array()?.iter().map(json_to_value).collect(),
                ),
                "$nin"    => Filter::Nin(
                    field.clone(),
                    val.as_array()?.iter().map(json_to_value).collect(),
                ),
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

fn parse_update(json: &str) -> Option<Update> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let obj = v.as_object()?;
    if let Some(set) = obj.get("$set") {
        let pairs = set.as_object()?.iter()
            .map(|(k, v)| (k.clone(), json_to_value(v))).collect();
        return Some(Update::Set(pairs));
    }
    if let Some(unset) = obj.get("$unset") {
        let keys = unset.as_object()?.keys().cloned().collect();
        return Some(Update::Unset(keys));
    }
    if let Some(inc) = obj.get("$inc") {
        let pairs = inc.as_object()?.iter()
            .map(|(k, v)| (k.clone(), json_to_value(v))).collect();
        return Some(Update::Inc(pairs));
    }
    if let Some(push) = obj.get("$push") {
        let map = push.as_object()?;
        let (k, v) = map.iter().next()?;
        return Some(Update::Push(k.clone(), json_to_value(v)));
    }
    if let Some(pull) = obj.get("$pull") {
        let map = pull.as_object()?;
        let (k, v) = map.iter().next()?;
        return Some(Update::Pull(k.clone(), json_to_value(v)));
    }
    None
}
