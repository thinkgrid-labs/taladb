//! Sync adapter interface for TalaDB.
//!
//! Defines the `SyncAdapter` trait and a built-in `LastWriteWins` (LWW)
//! implementation. A sync adapter is responsible for:
//!
//! 1. **Exporting** a changeset — the set of document mutations since a given
//!    logical clock / version vector.
//! 2. **Importing** a remote changeset — merging foreign mutations into the
//!    local database according to a conflict resolution policy.
//!
//! The adapter sits *above* the storage engine and works through the public
//! `Collection` API, so it is storage-agnostic.
//!
//! Changeset format
//! ----------------
//! A `Changeset` is a `Vec<Change>` where each `Change` records:
//! - The collection name
//! - The document ULID (ID)
//! - The operation (Upsert / Delete)
//! - A `u64` wall-clock timestamp (milliseconds since Unix epoch)
//! - The full document body (for Upserts)
//!
//! Last-Write-Wins conflict resolution
//! ------------------------------------
//! `LastWriteWins` merges by comparing `changed_at` timestamps. The change
//! with the higher timestamp wins. Ties are broken by ULID lexicographic
//! order (the higher ULID wins), ensuring a deterministic total order across
//! any number of replicas without coordination.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::document::{Document, Value};
use crate::error::TalaDbError;
use crate::query::filter::Filter;

// ---------------------------------------------------------------------------
// Mutation hook types (Phase 2)
// ---------------------------------------------------------------------------

/// A post-commit mutation event emitted after every successful write.
///
/// Only changed data is included — `Insert` carries the full document,
/// `Update` carries only the fields that changed (removed fields use
/// `Value::Null` as a tombstone), and `Delete` carries only the id.
#[derive(Debug, Clone)]
pub enum SyncEvent {
    Insert {
        collection: String,
        id: String,
        document: Document,
    },
    Update {
        collection: String,
        id: String,
        /// Changed fields only. A field set to `Value::Null` was removed.
        changes: HashMap<String, Value>,
    },
    Delete {
        collection: String,
        id: String,
    },
}

/// Receiver for post-commit mutation events.
///
/// Implementations **must be non-blocking**. Long-running work (HTTP requests,
/// disk I/O) must be offloaded to a background thread or async task inside
/// `on_event` — the call happens on the writer thread after commit returns.
///
/// `Arc<dyn SyncHook>` is stored inside `Collection` so one hook instance can
/// be shared across many collections.
pub trait SyncHook: Send + Sync {
    fn on_event(&self, event: SyncEvent);
}

/// No-operation sync hook. Default when sync is disabled — zero overhead.
pub struct NoopSyncHook;

impl SyncHook for NoopSyncHook {
    #[inline]
    fn on_event(&self, _event: SyncEvent) {}
}

// ---------------------------------------------------------------------------
// Test helper — RecordingSyncHook
// ---------------------------------------------------------------------------

/// Captures every event for use in unit tests.
///
/// Available only when `cfg(test)`.
#[cfg(test)]
pub struct RecordingSyncHook {
    events: std::sync::Mutex<Vec<SyncEvent>>,
}

#[cfg(test)]
impl RecordingSyncHook {
    pub fn new() -> Self {
        RecordingSyncHook {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Drain and return all recorded events in the order they were received.
    pub fn take(&self) -> Vec<SyncEvent> {
        self.events.lock().unwrap().drain(..).collect()
    }

    /// Number of events recorded so far without draining.
    pub fn len(&self) -> usize {
        self.events.lock().unwrap().len()
    }
}

#[cfg(test)]
impl SyncHook for RecordingSyncHook {
    fn on_event(&self, event: SyncEvent) {
        self.events.lock().unwrap().push(event);
    }
}

// ---------------------------------------------------------------------------
// Changeset types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChangeOp {
    /// Insert or replace a document.
    Upsert(Document),
    /// Delete a document by ID.
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    pub collection: String,
    pub id: Ulid,
    pub op: ChangeOp,
    /// Wall-clock timestamp in milliseconds since Unix epoch.
    pub changed_at: u64,
}

/// An ordered list of document changes to exchange between replicas.
pub type Changeset = Vec<Change>;

// ---------------------------------------------------------------------------
// SyncAdapter trait
// ---------------------------------------------------------------------------

/// Interface for syncing a TalaDB database with a remote peer.
pub trait SyncAdapter: Send + Sync {
    /// Export all changes that occurred after `since_ms` (exclusive).
    /// Returns a `Changeset` that can be sent to a remote peer.
    fn export_changes(
        &self,
        db: &crate::Database,
        collections: &[&str],
        since_ms: u64,
    ) -> Result<Changeset, TalaDbError>;

    /// Import a remote `Changeset` and merge it into the local database.
    /// Returns the number of documents actually changed (upserted or deleted).
    fn import_changes(
        &self,
        db: &crate::Database,
        changeset: Changeset,
    ) -> Result<u64, TalaDbError>;
}

// ---------------------------------------------------------------------------
// LastWriteWins implementation
// ---------------------------------------------------------------------------

/// Resolves conflicts by keeping the change with the highest `changed_at`
/// timestamp. Ties broken by ULID lexicographic order.
pub struct LastWriteWins;

impl LastWriteWins {
    pub fn new() -> Self {
        LastWriteWins
    }
}

impl Default for LastWriteWins {
    fn default() -> Self {
        LastWriteWins::new()
    }
}

impl SyncAdapter for LastWriteWins {
    fn export_changes(
        &self,
        db: &crate::Database,
        collections: &[&str],
        since_ms: u64,
    ) -> Result<Changeset, TalaDbError> {
        let mut changes = Vec::new();

        for &col_name in collections {
            let col = db.collection(col_name);
            // Fetch all documents — a production impl would filter by `_changed_at`
            // using a secondary index. Here we export everything and let the remote
            // filter by `since_ms`.
            let docs = col.find(Filter::All)?;
            for doc in docs {
                let changed_at = doc
                    .get("_changed_at")
                    .and_then(|v| {
                        if let Value::Int(ts) = v {
                            Some(*ts as u64)
                        } else {
                            None
                        }
                    })
                    // _changed_at defaults to 0 if absent — document always loses conflicts
                    .unwrap_or(0);

                if changed_at > since_ms {
                    changes.push(Change {
                        collection: col_name.to_string(),
                        id: doc.id,
                        op: ChangeOp::Upsert(doc),
                        changed_at,
                    });
                }
            }
        }

        Ok(changes)
    }

    fn import_changes(
        &self,
        db: &crate::Database,
        changeset: Changeset,
    ) -> Result<u64, TalaDbError> {
        let mut applied = 0u64;

        for change in changeset {
            let col = db.collection(&change.collection);

            match change.op {
                ChangeOp::Upsert(remote_doc) => {
                    // Look up local version of the document by ULID.
                    // _id is the Document::id field, not a field in the fields vec,
                    // so Filter::Eq("_id", ...) would never match. Use find_by_id instead.
                    let local = col.find_by_id(change.id)?;

                    let should_apply = match &local {
                        None => true,
                        Some(local_doc) => {
                            let local_ts = local_doc
                                .get("_changed_at")
                                .and_then(|v| {
                                    if let Value::Int(ts) = v {
                                        Some(*ts as u64)
                                    } else {
                                        None
                                    }
                                })
                                // _changed_at defaults to 0 if absent — document always loses conflicts
                                .unwrap_or(0);
                            // Remote wins if newer; ties broken by ULID order
                            change.changed_at > local_ts
                                || (change.changed_at == local_ts && change.id > local_doc.id)
                        }
                    };

                    if should_apply {
                        // Delete local copy (if any) then insert remote doc preserving its ULID
                        if local.is_some() {
                            col.delete_by_id(change.id)?;
                        }
                        col.insert_with_id(remote_doc)?;
                        applied += 1;
                    }
                }

                ChangeOp::Delete => {
                    // _id is Document::id, not a field — use delete_by_id
                    let deleted = col.delete_by_id(change.id)?;
                    if deleted {
                        applied += 1;
                    }
                }
            }
        }

        Ok(applied)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Current wall-clock time in milliseconds since Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Stamp a document field `_changed_at` with the current wall-clock time.
/// Call this before inserting/updating a document that participates in sync.
pub fn stamp(fields: &mut Vec<(String, Value)>) {
    fields.retain(|(k, _)| k != "_changed_at");
    fields.push(("_changed_at".into(), Value::Int(now_ms() as i64)));
}
