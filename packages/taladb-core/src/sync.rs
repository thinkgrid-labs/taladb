/// Sync adapter interface for TalaDB.
///
/// Defines the `SyncAdapter` trait and a built-in `LastWriteWins` (LWW)
/// implementation. A sync adapter is responsible for:
///
/// 1. **Exporting** a changeset — the set of document mutations since a given
///    logical clock / version vector.
/// 2. **Importing** a remote changeset — merging foreign mutations into the
///    local database according to a conflict resolution policy.
///
/// The adapter sits *above* the storage engine and works through the public
/// `Collection` API, so it is storage-agnostic.
///
/// Changeset format
/// ----------------
/// A `Changeset` is a `Vec<Change>` where each `Change` records:
/// - The collection name
/// - The document ULID (ID)
/// - The operation (Upsert / Delete)
/// - A `u64` wall-clock timestamp (milliseconds since Unix epoch)
/// - The full document body (for Upserts)
///
/// Last-Write-Wins conflict resolution
/// ------------------------------------
/// `LastWriteWins` merges by comparing `changed_at` timestamps. The change
/// with the higher timestamp wins. Ties are broken by ULID lexicographic
/// order (the higher ULID wins), ensuring a deterministic total order across
/// any number of replicas without coordination.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::document::{Document, Value};
use crate::error::ZeroDbError;
use crate::query::filter::Filter;

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
    ) -> Result<Changeset, ZeroDbError>;

    /// Import a remote `Changeset` and merge it into the local database.
    /// Returns the number of documents actually changed (upserted or deleted).
    fn import_changes(
        &self,
        db: &crate::Database,
        changeset: Changeset,
    ) -> Result<u64, ZeroDbError>;
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
    ) -> Result<Changeset, ZeroDbError> {
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
                    .and_then(|v| if let Value::Int(ts) = v { Some(*ts as u64) } else { None })
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
    ) -> Result<u64, ZeroDbError> {
        let mut applied = 0u64;

        for change in changeset {
            let col = db.collection(&change.collection);

            match change.op {
                ChangeOp::Upsert(remote_doc) => {
                    // Look up local version of the document
                    let local = col.find_one(Filter::Eq(
                        "_id".into(),
                        Value::Str(change.id.to_string()),
                    ))?;

                    let should_apply = match &local {
                        None => true,
                        Some(local_doc) => {
                            let local_ts = local_doc
                                .get("_changed_at")
                                .and_then(|v| if let Value::Int(ts) = v { Some(*ts as u64) } else { None })
                                .unwrap_or(0);
                            // Remote wins if newer; ties broken by ULID order
                            change.changed_at > local_ts
                                || (change.changed_at == local_ts
                                    && change.id > local_doc.id)
                        }
                    };

                    if should_apply {
                        // Delete local copy (if any) then insert remote doc
                        if local.is_some() {
                            col.delete_one(Filter::Eq(
                                "_id".into(),
                                Value::Str(change.id.to_string()),
                            ))?;
                        }
                        let fields: Vec<(String, Value)> = remote_doc
                            .fields
                            .into_iter()
                            .collect();
                        col.insert(fields)?;
                        applied += 1;
                    }
                }

                ChangeOp::Delete => {
                    let deleted = col.delete_one(Filter::Eq(
                        "_id".into(),
                        Value::Str(change.id.to_string()),
                    ))?;
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
