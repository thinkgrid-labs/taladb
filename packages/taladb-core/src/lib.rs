pub mod aggregate;
pub mod audit;
pub mod collection;
pub mod config;
pub mod crypto;
pub mod document;
pub mod engine;
pub mod error;
pub mod fts;
#[cfg(feature = "sync-http")]
pub mod http_sync;
pub mod index;
pub mod migration;
pub mod query;
pub mod sync;
pub mod vector;
pub mod watch;

pub use aggregate::{Accumulator, GroupKey, Pipeline, Stage};
pub use audit::{read_audit_log, read_audit_log_since, AuditEntry, AuditOp};
pub use collection::{Collection, CollectionIndexInfo, Update};
pub use config::{load_auto, load_from_path, SyncConfig, TalaDbConfig};
#[cfg(feature = "encryption")]
pub use crypto::{migrate_encrypted_v0_to_v1, rekey, EncryptionKey};
pub use document::{Document, Value};
pub use engine::{RedbBackend, StorageBackend};
pub use error::TalaDbError;
#[cfg(feature = "sync-http")]
pub use http_sync::HttpSyncHook;
pub use migration::{run_migrations, Migration};
pub use query::options::{FindOptions, SortDirection, SortSpec};
pub use query::Filter;
pub use sync::{Changeset, LastWriteWins, NoopSyncHook, SyncAdapter, SyncEvent, SyncHook};
pub use vector::{HnswOptions, VectorMetric, VectorSearchResult};

use std::path::Path;
use std::sync::Arc;

// Snapshot magic + version bytes written at the start of every snapshot.
const SNAPSHOT_MAGIC: &[u8; 4] = b"TDBS";
const SNAPSHOT_VERSION: u32 = 1;

/// The main TalaDB database handle.
pub struct Database {
    backend: Arc<dyn StorageBackend>,
    #[cfg(feature = "vector-hnsw")]
    hnsw_cache: vector::SharedHnswCache,
}

impl Database {
    /// Open a file-backed database at the given path.
    pub fn open(path: &Path) -> Result<Self, TalaDbError> {
        let backend = RedbBackend::open(path)?;
        Ok(Database {
            backend: Arc::new(backend),
            #[cfg(feature = "vector-hnsw")]
            hnsw_cache: vector::new_shared_cache(),
        })
    }

    /// Open a database with a custom storage backend (e.g. OPFS in WASM).
    pub fn open_with_backend(backend: Box<dyn StorageBackend>) -> Result<Self, TalaDbError> {
        Ok(Database {
            backend: Arc::from(backend),
            #[cfg(feature = "vector-hnsw")]
            hnsw_cache: vector::new_shared_cache(),
        })
    }

    /// Open an in-memory database (useful for tests).
    pub fn open_in_memory() -> Result<Self, TalaDbError> {
        let backend = RedbBackend::open_in_memory()?;
        Ok(Database {
            backend: Arc::new(backend),
            #[cfg(feature = "vector-hnsw")]
            hnsw_cache: vector::new_shared_cache(),
        })
    }

    /// Open a database and run any pending migrations before returning.
    pub fn open_with_migrations(
        path: &Path,
        migrations: &[Migration],
    ) -> Result<Self, TalaDbError> {
        let backend = Arc::new(RedbBackend::open(path)?);
        run_migrations(backend.as_ref(), migrations)?;
        Ok(Database {
            backend,
            #[cfg(feature = "vector-hnsw")]
            hnsw_cache: vector::new_shared_cache(),
        })
    }

    /// Access the raw storage backend.
    ///
    /// Useful for calling lower-level APIs such as [`read_audit_log`] and
    /// [`rekey`] that operate directly on the backend rather than through a
    /// `Collection` handle.
    pub fn backend(&self) -> &dyn StorageBackend {
        self.backend.as_ref()
    }

    /// Get a collection handle by name.
    ///
    /// # Errors
    /// Returns [`TalaDbError::InvalidName`] if `name` is empty, longer than 128
    /// characters, or contains the `"::"` separator reserved for internal table
    /// naming.
    pub fn collection(&self, name: &str) -> Result<Collection, TalaDbError> {
        collection::validate_collection_name(name)?;
        let col = Collection::new(name, Arc::clone(&self.backend));
        #[cfg(feature = "vector-hnsw")]
        let col = col.with_hnsw_cache(Arc::clone(&self.hnsw_cache));
        Ok(col)
    }

    /// Warm the in-memory HNSW cache by rebuilding all graphs whose options are
    /// stored in [`META_HNSW_TABLE`].  Call this once after `Database::open*`
    /// if you want approximate-nearest-neighbor search to be available
    /// immediately without waiting for the first `upgrade_vector_index` call.
    ///
    /// No-op when the `vector-hnsw` feature is disabled.
    #[cfg(feature = "vector-hnsw")]
    pub fn rebuild_hnsw_indexes(&self) -> Result<(), TalaDbError> {
        let txn = self.backend.begin_read()?;
        let all = txn.scan_all(vector::META_HNSW_TABLE).unwrap_or_default();
        drop(txn);

        for (k, _) in all {
            let key_str = match std::str::from_utf8(&k) {
                Ok(s) => s.to_string(),
                Err(_) => continue,
            };
            let mut parts = key_str.splitn(2, "::");
            let col_name = match parts.next() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let field = match parts.next() {
                Some(s) => s.to_string(),
                None => continue,
            };
            self.collection(&col_name)?.upgrade_vector_index(&field)?;
        }
        Ok(())
    }

    /// Compact the underlying storage file, reclaiming space freed by deletes
    /// and updates. Useful after bulk deletes or large tombstone pruning.
    ///
    /// This is a blocking operation proportional to database size; call it
    /// during idle periods (e.g. at startup after tombstone compaction).
    ///
    /// No-op on in-memory backends.
    pub fn compact(&self) -> Result<(), TalaDbError> {
        self.backend.compact()
    }

    /// Return the names of all collections stored in this database.
    ///
    /// Derived by scanning table names for the `docs::` prefix used by the
    /// document storage layer.
    pub fn list_collection_names(&self) -> Result<Vec<String>, TalaDbError> {
        let txn = self.backend.begin_read()?;
        let mut names: Vec<String> = txn
            .list_tables()?
            .into_iter()
            .filter_map(|t| t.strip_prefix("docs::").map(str::to_string))
            .collect();
        names.sort();
        Ok(names)
    }

    /// Serialize the entire database state to a compact binary snapshot.
    ///
    /// The snapshot can be stored anywhere (e.g. OPFS) and later passed to
    /// [`Database::restore_from_snapshot`] to recreate an identical in-memory
    /// database.  Intended for the browser WASM snapshot-flush persistence
    /// strategy; not suited for databases larger than ~50 MB.
    ///
    /// Format: `TDBS` magic (4 B) + version u32 LE (4 B) + table count u32 LE,
    /// then for each table: name length u32 LE, name bytes, entry count u64 LE,
    /// then for each entry: key length u32 LE, key bytes, value length u32 LE,
    /// value bytes.
    #[tracing::instrument(skip(self))]
    pub fn export_snapshot(&self) -> Result<Vec<u8>, TalaDbError> {
        let txn = self.backend.begin_read()?;
        let table_names = txn.list_tables()?;

        let mut buf = Vec::new();
        buf.extend_from_slice(SNAPSHOT_MAGIC);
        buf.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());

        // Collect all tables first so we can write the count up front.
        let mut tables: Vec<(String, engine::KvPairs)> = Vec::new();
        for name in table_names {
            let pairs = txn.scan_all(&name)?;
            tables.push((name, pairs));
        }

        buf.extend_from_slice(&(tables.len() as u32).to_le_bytes());
        for (name, pairs) in &tables {
            let name_bytes = name.as_bytes();
            buf.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
            buf.extend_from_slice(name_bytes);
            buf.extend_from_slice(&(pairs.len() as u64).to_le_bytes());
            for (key, val) in pairs {
                buf.extend_from_slice(&(key.len() as u32).to_le_bytes());
                buf.extend_from_slice(key);
                buf.extend_from_slice(&(val.len() as u32).to_le_bytes());
                buf.extend_from_slice(val);
            }
        }
        Ok(buf)
    }

    /// Restore a database from a snapshot produced by [`Database::export_snapshot`].
    ///
    /// Returns an in-memory database pre-loaded with all data from the snapshot.
    /// Returns [`TalaDbError::InvalidSnapshot`] if the data is corrupt or from an
    /// incompatible snapshot version.
    pub fn restore_from_snapshot(data: &[u8]) -> Result<Self, TalaDbError> {
        /// Hard cap — prevents OOM from corrupted or crafted snapshots.
        /// 2 GiB on 32-bit targets (WASM), 10 GiB on 64-bit targets.
        #[cfg(target_pointer_width = "32")]
        const MAX_SNAPSHOT_SIZE: usize = 2 * 1024 * 1024 * 1024; // 2 GiB fits in u32
        #[cfg(not(target_pointer_width = "32"))]
        const MAX_SNAPSHOT_SIZE: usize = 10 * 1024 * 1024 * 1024; // 10 GiB
        if data.len() > MAX_SNAPSHOT_SIZE {
            return Err(TalaDbError::InvalidSnapshot);
        }
        if data.len() < 12 || &data[..4] != SNAPSHOT_MAGIC {
            return Err(TalaDbError::InvalidSnapshot);
        }
        let version = u32::from_le_bytes(
            data[4..8]
                .try_into()
                .map_err(|_| TalaDbError::InvalidSnapshot)?,
        );
        if version != SNAPSHOT_VERSION {
            return Err(TalaDbError::InvalidSnapshot);
        }

        let db = Database::open_in_memory()?;
        let mut cursor: usize = 8;

        let table_count = read_u32(data, &mut cursor)? as usize;
        for _ in 0..table_count {
            let name_len = read_u32(data, &mut cursor)? as usize;
            let name = std::str::from_utf8(read_slice(data, &mut cursor, name_len)?)
                .map_err(|_| TalaDbError::InvalidSnapshot)?
                .to_string();

            let entry_count = read_u64(data, &mut cursor)? as usize;

            // Write all entries for this table in a single transaction.
            let mut wtxn = db.backend.begin_write()?;
            for _ in 0..entry_count {
                let key_len = read_u32(data, &mut cursor)? as usize;
                let key = read_slice(data, &mut cursor, key_len)?.to_vec();
                let val_len = read_u32(data, &mut cursor)? as usize;
                let val = read_slice(data, &mut cursor, val_len)?.to_vec();
                wtxn.put(&name, &key, &val)?;
            }
            wtxn.commit()?;
        }

        Ok(db)
    }
}

// ---------------------------------------------------------------------------
// Snapshot binary helpers
// ---------------------------------------------------------------------------

fn read_u32(data: &[u8], cursor: &mut usize) -> Result<u32, TalaDbError> {
    let end = cursor.checked_add(4).ok_or(TalaDbError::InvalidSnapshot)?;
    if end > data.len() {
        return Err(TalaDbError::InvalidSnapshot);
    }
    let val = u32::from_le_bytes(
        data[*cursor..end]
            .try_into()
            .map_err(|_| TalaDbError::InvalidSnapshot)?,
    );
    *cursor = end;
    Ok(val)
}

fn read_u64(data: &[u8], cursor: &mut usize) -> Result<u64, TalaDbError> {
    let end = cursor.checked_add(8).ok_or(TalaDbError::InvalidSnapshot)?;
    if end > data.len() {
        return Err(TalaDbError::InvalidSnapshot);
    }
    let val = u64::from_le_bytes(
        data[*cursor..end]
            .try_into()
            .map_err(|_| TalaDbError::InvalidSnapshot)?,
    );
    *cursor = end;
    Ok(val)
}

fn read_slice<'a>(data: &'a [u8], cursor: &mut usize, len: usize) -> Result<&'a [u8], TalaDbError> {
    let end = cursor
        .checked_add(len)
        .ok_or(TalaDbError::InvalidSnapshot)?;
    if end > data.len() {
        return Err(TalaDbError::InvalidSnapshot);
    }
    let slice = &data[*cursor..end];
    *cursor = end;
    Ok(slice)
}
