//! HTTP push sync dispatcher — `sync-http` feature.
//!
//! [`HttpSyncHook`] implements [`SyncHook`] by firing an HTTP POST to a
//! configured endpoint after every successful write commit. Requests are sent
//! on a background OS thread so `on_event` returns immediately.
//!
//! # Payload shape
//!
//! **insert**
//! ```json
//! {
//!   "_taladb_event": "insert",
//!   "collection": "users",
//!   "id": "01J4X...",
//!   "document": { "name": "Alice", "age": 30 },
//!   "timestamp": 1720000000000
//! }
//! ```
//!
//! **update** — only changed fields; removed fields carry `null`
//! ```json
//! {
//!   "_taladb_event": "update",
//!   "collection": "users",
//!   "id": "01J4X...",
//!   "changes": { "age": 31 },
//!   "timestamp": 1720000000000
//! }
//! ```
//!
//! **delete**
//! ```json
//! {
//!   "_taladb_event": "delete",
//!   "collection": "users",
//!   "id": "01J4X...",
//!   "timestamp": 1720000000000
//! }
//! ```

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value as JsonValue};

use crate::config::SyncConfig;
use crate::document::{Document, Value};
use crate::sync::{now_ms, SyncEvent, SyncHook};

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/// Number of background worker threads in the sync thread pool.
const WORKER_THREADS: usize = 4;

/// Capacity of the bounded task channel. Back-pressure kicks in when the pool
/// is saturated — `on_event` will drop events rather than block the writer.
const TASK_CHANNEL_CAPACITY: usize = 256;

struct SyncTask {
    endpoint: String,
    headers: HashMap<String, String>,
    payload: JsonValue,
}

/// Fires an HTTP POST for every mutation event.
///
/// - Uses a fixed pool of [`WORKER_THREADS`] background threads sharing a
///   single `reqwest::blocking::Client` — no per-event thread spawn overhead.
/// - The task channel is bounded to [`TASK_CHANNEL_CAPACITY`]; events are
///   dropped (with a warning) when the pool is fully saturated rather than
///   blocking the writer thread.
/// - Retries up to 3 times on 5xx / network error with 200 / 400 / 800 ms
///   exponential backoff. 4xx responses are not retried (permanent error).
///
/// # Usage
/// ```ignore
/// let hook = Arc::new(HttpSyncHook::new(config.sync));
/// let col = db.collection("users")?
///     .with_sync_hook(hook as Arc<dyn SyncHook>);
/// ```
pub struct HttpSyncHook {
    config: Arc<SyncConfig>,
    /// Sender half of the bounded worker channel. `None` when sync is disabled.
    tx: Option<std::sync::mpsc::SyncSender<SyncTask>>,
}

impl HttpSyncHook {
    /// Build the hook from a `SyncConfig`.
    ///
    /// When `config.enabled` is `true`, spawns [`WORKER_THREADS`] background
    /// threads that share one `reqwest::blocking::Client`.
    pub fn new(config: SyncConfig) -> Self {
        if !config.enabled {
            return HttpSyncHook {
                config: Arc::new(config),
                tx: None,
            };
        }

        let (tx, rx) = std::sync::mpsc::sync_channel::<SyncTask>(TASK_CHANNEL_CAPACITY);
        // Wrap receiver in Arc<Mutex> so it can be shared across worker threads.
        let rx = Arc::new(Mutex::new(rx));

        for _ in 0..WORKER_THREADS {
            let rx = Arc::clone(&rx);
            std::thread::spawn(move || {
                // Build the reqwest client inside the worker thread.
                // This avoids the "cannot drop runtime in async context" panic
                // that occurs when the client (which holds a tokio runtime) is
                // dropped from within a tokio-managed thread (e.g. #[tokio::test]).
                let client = match reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!(error = %e, "sync: worker failed to build HTTP client");
                        return;
                    }
                };
                loop {
                    let task = {
                        let guard = rx.lock().unwrap_or_else(|p| p.into_inner());
                        guard.recv()
                    };
                    match task {
                        Ok(t) => fire_with_retry(&client, &t.endpoint, &t.headers, &t.payload),
                        // Channel closed — all senders dropped, shut down.
                        Err(_) => break,
                    }
                }
            });
        }

        HttpSyncHook {
            config: Arc::new(config),
            tx: Some(tx),
        }
    }

    fn endpoint_for(&self, event: &SyncEvent) -> Option<String> {
        let cfg = &*self.config;
        match event {
            SyncEvent::Insert { .. } => {
                cfg.insert_endpoint.clone().or_else(|| cfg.endpoint.clone())
            }
            SyncEvent::Update { .. } => {
                cfg.update_endpoint.clone().or_else(|| cfg.endpoint.clone())
            }
            SyncEvent::Delete { .. } => {
                cfg.delete_endpoint.clone().or_else(|| cfg.endpoint.clone())
            }
        }
    }
}

impl SyncHook for HttpSyncHook {
    fn on_event(&self, event: SyncEvent) {
        let Some(tx) = &self.tx else {
            return;
        };
        let Some(endpoint) = self.endpoint_for(&event) else {
            return;
        };
        let payload = event_to_payload(event, &self.config.exclude_fields);
        let headers = self.config.headers.clone();
        let task = SyncTask {
            endpoint,
            headers,
            payload,
        };
        // try_send: drops the event if the channel is full rather than blocking.
        if let Err(e) = tx.try_send(task) {
            tracing::warn!(error = %e, "sync: task channel full; dropping sync event");
        }
    }
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

pub(crate) fn event_to_payload(event: SyncEvent, exclude: &[String]) -> JsonValue {
    let ts = now_ms();
    match event {
        SyncEvent::Insert {
            collection,
            id,
            document,
        } => json!({
            "_taladb_event": "insert",
            "collection": collection,
            "id": id,
            "document": doc_fields_to_json(&document, exclude),
            "timestamp": ts,
        }),
        SyncEvent::Update {
            collection,
            id,
            changes,
        } => json!({
            "_taladb_event": "update",
            "collection": collection,
            "id": id,
            "changes": map_to_json(&changes, exclude),
            "timestamp": ts,
        }),
        SyncEvent::Delete { collection, id } => json!({
            "_taladb_event": "delete",
            "collection": collection,
            "id": id,
            "timestamp": ts,
        }),
    }
}

/// Convert a document's fields (not including `_id`) to a JSON object,
/// omitting any field listed in `exclude`.
fn doc_fields_to_json(doc: &Document, exclude: &[String]) -> JsonValue {
    let mut obj = Map::new();
    for (k, v) in &doc.fields {
        if !exclude.contains(k) {
            obj.insert(k.clone(), value_to_json(v));
        }
    }
    JsonValue::Object(obj)
}

/// Convert a field map to a JSON object, omitting any field listed in `exclude`.
fn map_to_json(fields: &HashMap<String, Value>, exclude: &[String]) -> JsonValue {
    let mut obj = Map::new();
    for (k, v) in fields {
        if !exclude.contains(k) {
            obj.insert(k.clone(), value_to_json(v));
        }
    }
    JsonValue::Object(obj)
}

pub(crate) fn value_to_json(v: &Value) -> JsonValue {
    match v {
        Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Int(n) => JsonValue::Number(serde_json::Number::from(*n)),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Value::Str(s) => JsonValue::String(s.clone()),
        // Bytes serialised as a hex string with a `$hex:` prefix so receivers
        // can detect and decode them if needed.
        Value::Bytes(b) => JsonValue::String(format!("$hex:{}", hex_encode(b))),
        Value::Array(arr) => JsonValue::Array(arr.iter().map(value_to_json).collect()),
        Value::Object(pairs) => {
            let mut obj = Map::new();
            for (k, val) in pairs {
                obj.insert(k.clone(), value_to_json(val));
            }
            JsonValue::Object(obj)
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

// ---------------------------------------------------------------------------
// HTTP dispatcher with exponential-backoff retry
// ---------------------------------------------------------------------------

/// Delays before attempt 2, 3, 4 (ms).
const BACKOFFS_MS: &[u64] = &[200, 400, 800];

/// POST `payload` to `endpoint`, retrying on 5xx / network errors.
/// 4xx responses are treated as permanent and not retried.
/// Logs to stderr after all attempts are exhausted so operators can detect
/// replication failures.
fn fire_with_retry(
    client: &reqwest::blocking::Client,
    endpoint: &str,
    headers: &HashMap<String, String>,
    payload: &JsonValue,
) {
    use reqwest::header::{HeaderName, HeaderValue};

    let max_attempts = BACKOFFS_MS.len() + 1; // 4 total (1 + 3 retries)
    for attempt in 0..max_attempts {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(BACKOFFS_MS[attempt - 1]));
        }

        let mut req = client.post(endpoint).json(payload);
        for (k, v) in headers {
            // Parse header name/value through reqwest's typed API so invalid
            // characters (CRLF, null bytes) are rejected rather than injected.
            match (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                (Ok(name), Ok(value)) => {
                    req = req.header(name, value);
                }
                _ => {
                    tracing::warn!(key = ?k, "sync: skipping invalid header name or value");
                }
            }
        }

        match req.send() {
            Ok(resp) if resp.status().is_success() => return,
            // 5xx — transient server error, retry
            Ok(resp) if resp.status().is_server_error() => continue,
            // 4xx or other — permanent error, don't retry
            Ok(_) => return,
            // Network / timeout error — retry
            Err(_) => continue,
        }
    }
    // All attempts exhausted — log so operators can detect replication failures.
    tracing::error!(
        attempts = max_attempts,
        endpoint,
        "sync: event permanently failed after all retry attempts"
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::config::SyncConfig;
    use crate::document::Value;
    use crate::sync::SyncHook;
    use crate::Database;

    fn enabled_config(uri: &str) -> SyncConfig {
        SyncConfig {
            enabled: true,
            endpoint: Some(format!("{uri}/events")),
            ..Default::default()
        }
    }

    // ── payload shape ────────────────────────────────────────────────────────

    #[test]
    fn insert_payload_shape() {
        use crate::document::Document;
        use crate::sync::SyncEvent;

        let doc = Document::new(vec![
            ("name".into(), Value::Str("Alice".into())),
            ("age".into(), Value::Int(30)),
        ]);
        let event = SyncEvent::Insert {
            collection: "users".into(),
            id: doc.id.to_string(),
            document: doc,
        };
        let p = event_to_payload(event, &[]);
        assert_eq!(p["_taladb_event"], "insert");
        assert_eq!(p["collection"], "users");
        assert_eq!(p["document"]["name"], "Alice");
        assert_eq!(p["document"]["age"], 30);
        assert!(p["timestamp"].as_u64().unwrap() > 0);
    }

    #[test]
    fn update_payload_shape() {
        use crate::sync::SyncEvent;

        let event = SyncEvent::Update {
            collection: "users".into(),
            id: "abc".into(),
            changes: [
                ("age".into(), Value::Int(31)),
                ("old_field".into(), Value::Null),
            ]
            .into_iter()
            .collect(),
        };
        let p = event_to_payload(event, &[]);
        assert_eq!(p["_taladb_event"], "update");
        assert_eq!(p["changes"]["age"], 31);
        assert!(p["changes"]["old_field"].is_null());
        assert!(p.get("document").is_none());
    }

    #[test]
    fn delete_payload_shape() {
        use crate::sync::SyncEvent;

        let event = SyncEvent::Delete {
            collection: "items".into(),
            id: "xyz".into(),
        };
        let p = event_to_payload(event, &[]);
        assert_eq!(p["_taladb_event"], "delete");
        assert_eq!(p["collection"], "items");
        assert_eq!(p["id"], "xyz");
        assert!(p.get("document").is_none());
        assert!(p.get("changes").is_none());
    }

    // ── exclude_fields ───────────────────────────────────────────────────────

    #[test]
    fn exclude_fields_stripped_from_insert() {
        use crate::document::Document;
        use crate::sync::SyncEvent;

        let doc = Document::new(vec![
            ("title".into(), Value::Str("Hello".into())),
            (
                "embedding".into(),
                Value::Array(vec![Value::Float(0.1), Value::Float(0.2)]),
            ),
            ("score".into(), Value::Float(0.99)),
        ]);
        let event = SyncEvent::Insert {
            collection: "articles".into(),
            id: doc.id.to_string(),
            document: doc,
        };
        let exclude = vec!["embedding".to_string(), "score".to_string()];
        let p = event_to_payload(event, &exclude);

        // Excluded fields absent.
        assert!(p["document"].get("embedding").is_none());
        assert!(p["document"].get("score").is_none());
        // Non-excluded field present.
        assert_eq!(p["document"]["title"], "Hello");
    }

    #[test]
    fn exclude_fields_stripped_from_update_changes() {
        use crate::sync::SyncEvent;

        let event = SyncEvent::Update {
            collection: "articles".into(),
            id: "abc".into(),
            changes: [
                ("title".into(), Value::Str("New title".into())),
                ("embedding".into(), Value::Array(vec![Value::Float(0.5)])),
            ]
            .into_iter()
            .collect(),
        };
        let exclude = vec!["embedding".to_string()];
        let p = event_to_payload(event, &exclude);

        assert!(p["changes"].get("embedding").is_none());
        assert_eq!(p["changes"]["title"], "New title");
    }

    #[test]
    fn exclude_unknown_fields_is_noop() {
        use crate::document::Document;
        use crate::sync::SyncEvent;

        let doc = Document::new(vec![("name".into(), Value::Str("Alice".into()))]);
        let event = SyncEvent::Insert {
            collection: "users".into(),
            id: doc.id.to_string(),
            document: doc,
        };
        // Excluding a field that doesn't exist in the document is silently ignored.
        let exclude = vec!["nonexistent_field".to_string()];
        let p = event_to_payload(event, &exclude);

        assert_eq!(p["document"]["name"], "Alice");
    }

    #[test]
    fn empty_exclude_list_includes_all_fields() {
        use crate::document::Document;
        use crate::sync::SyncEvent;

        let doc = Document::new(vec![
            ("name".into(), Value::Str("Bob".into())),
            ("embedding".into(), Value::Array(vec![Value::Float(1.0)])),
        ]);
        let event = SyncEvent::Insert {
            collection: "users".into(),
            id: doc.id.to_string(),
            document: doc,
        };
        let p = event_to_payload(event, &[]);

        assert_eq!(p["document"]["name"], "Bob");
        assert!(p["document"]["embedding"].is_array());
    }

    // ── value_to_json ────────────────────────────────────────────────────────

    #[test]
    fn value_conversions() {
        assert_eq!(value_to_json(&Value::Null), JsonValue::Null);
        assert_eq!(value_to_json(&Value::Bool(true)), JsonValue::Bool(true));
        assert_eq!(value_to_json(&Value::Int(-5)), json!(-5));
        assert_eq!(value_to_json(&Value::Float(3.14)), json!(3.14));
        assert_eq!(
            value_to_json(&Value::Str("hi".into())),
            JsonValue::String("hi".into())
        );
        assert_eq!(
            value_to_json(&Value::Bytes(vec![0xde, 0xad])),
            JsonValue::String("$hex:dead".into())
        );
        assert_eq!(
            value_to_json(&Value::Array(vec![Value::Int(1), Value::Int(2)])),
            json!([1, 2])
        );
        assert_eq!(
            value_to_json(&Value::Object(vec![("k".into(), Value::Bool(false))])),
            json!({"k": false})
        );
    }

    // ── disabled hook ────────────────────────────────────────────────────────

    #[test]
    fn disabled_config_fires_no_request() {
        // No server needed — any HTTP attempt would fail anyway.
        let config = SyncConfig {
            enabled: false,
            endpoint: Some("http://127.0.0.1:1".into()), // port 1 — nothing listening
            ..Default::default()
        };
        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(config));
        let col = db
            .collection("items")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);
        // Should complete instantly (no network call)
        col.insert(vec![("x".into(), Value::Int(1))]).unwrap();
    }

    // ── live HTTP tests (wiremock) ────────────────────────────────────────────

    #[tokio::test]
    async fn insert_fires_post_to_endpoint() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/events"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(enabled_config(&server.uri())));
        let col = db
            .collection("users")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);

        col.insert(vec![("name".into(), Value::Str("Alice".into()))])
            .unwrap();

        tokio::time::sleep(Duration::from_millis(300)).await;

        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let body: JsonValue = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body["_taladb_event"], "insert");
        assert_eq!(body["collection"], "users");
        assert_eq!(body["document"]["name"], "Alice");
        assert!(body["timestamp"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn update_fires_post_with_changes_only() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/events"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(enabled_config(&server.uri())));
        let col = db
            .collection("users")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);

        col.insert(vec![
            ("name".into(), Value::Str("Bob".into())),
            ("score".into(), Value::Int(10)),
        ])
        .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = server.received_requests().await; // drain insert

        col.update_one(
            crate::query::Filter::Eq("name".into(), Value::Str("Bob".into())),
            crate::collection::Update::Set(vec![("score".into(), Value::Int(99))]),
        )
        .unwrap();

        tokio::time::sleep(Duration::from_millis(300)).await;

        let reqs = server.received_requests().await.unwrap();
        // The last request is the update
        let update_req = reqs.last().unwrap();
        let body: JsonValue = serde_json::from_slice(&update_req.body).unwrap();
        assert_eq!(body["_taladb_event"], "update");
        assert_eq!(body["changes"]["score"], 99);
        assert!(!body["changes"].as_object().unwrap().contains_key("name"));
    }

    #[tokio::test]
    async fn delete_fires_post_with_id_only() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/events"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(enabled_config(&server.uri())));
        let col = db
            .collection("items")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);

        let id = col
            .insert(vec![("tag".into(), Value::Str("x".into()))])
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = server.received_requests().await;

        col.delete_one(crate::query::Filter::Eq(
            "tag".into(),
            Value::Str("x".into()),
        ))
        .unwrap();

        tokio::time::sleep(Duration::from_millis(300)).await;

        let reqs = server.received_requests().await.unwrap();
        let body: JsonValue = serde_json::from_slice(&reqs.last().unwrap().body).unwrap();
        assert_eq!(body["_taladb_event"], "delete");
        assert_eq!(body["id"], id.to_string());
        assert!(body.get("document").is_none());
        assert!(body.get("changes").is_none());
    }

    #[tokio::test]
    async fn custom_headers_sent_with_request() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(header("Authorization", "Bearer secret"))
            .and(header("X-Custom", "value"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let config = SyncConfig {
            enabled: true,
            endpoint: Some(format!("{}/events", server.uri())),
            headers: [
                ("Authorization".into(), "Bearer secret".into()),
                ("X-Custom".into(), "value".into()),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        };

        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(config));
        let col = db
            .collection("items")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);

        col.insert(vec![("x".into(), Value::Int(1))]).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        // wiremock asserts the expect(1) on drop
    }

    #[tokio::test]
    async fn per_event_endpoint_override() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/inserts"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        // Default endpoint points somewhere else; insert_endpoint overrides it.
        let config = SyncConfig {
            enabled: true,
            endpoint: Some(format!("{}/default", server.uri())),
            insert_endpoint: Some(format!("{}/inserts", server.uri())),
            ..Default::default()
        };

        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(config));
        let col = db
            .collection("items")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);

        col.insert(vec![("y".into(), Value::Bool(true))]).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    #[tokio::test]
    async fn retries_on_5xx_then_succeeds() {
        let server = MockServer::start().await;

        // First response: 500, second: 200
        Mock::given(method("POST"))
            .and(path("/events"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/events"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(enabled_config(&server.uri())));
        let col = db
            .collection("items")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);

        col.insert(vec![("z".into(), Value::Int(42))]).unwrap();
        // Wait long enough for first attempt + 200 ms backoff + second attempt
        tokio::time::sleep(Duration::from_millis(800)).await;

        let reqs = server.received_requests().await.unwrap();
        assert!(
            reqs.len() >= 2,
            "expected at least 2 attempts, got {}",
            reqs.len()
        );
    }

    #[tokio::test]
    async fn no_retry_on_4xx() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/events"))
            .respond_with(ResponseTemplate::new(400))
            .expect(1) // exactly one attempt — no retry
            .mount(&server)
            .await;

        let db = Database::open_in_memory().unwrap();
        let hook = Arc::new(HttpSyncHook::new(enabled_config(&server.uri())));
        let col = db
            .collection("items")
            .unwrap()
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);

        col.insert(vec![("w".into(), Value::Int(1))]).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
