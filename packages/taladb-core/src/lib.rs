pub mod collection;
pub mod crypto;
pub mod document;
pub mod engine;
pub mod error;
pub mod fts;
pub mod index;
pub mod migration;
pub mod query;
pub mod sync;
pub mod vector;
pub mod watch;

pub use collection::{Collection, Update};
pub use document::{Document, Value};
pub use engine::{RedbBackend, StorageBackend};
pub use error::TalaDbError;
pub use migration::{run_migrations, Migration};
pub use query::Filter;
pub use vector::{VectorMetric, VectorSearchResult};

use std::path::Path;
use std::sync::Arc;

// Snapshot magic + version bytes written at the start of every snapshot.
const SNAPSHOT_MAGIC: &[u8; 4] = b"TDBS";
const SNAPSHOT_VERSION: u32 = 1;

/// The main TalaDB database handle.
pub struct Database {
    backend: Arc<dyn StorageBackend>,
}

impl Database {
    /// Open a file-backed database at the given path.
    pub fn open(path: &Path) -> Result<Self, TalaDbError> {
        let backend = RedbBackend::open(path)?;
        Ok(Database {
            backend: Arc::new(backend),
        })
    }

    /// Open a database with a custom storage backend (e.g. OPFS in WASM).
    pub fn open_with_backend(backend: Box<dyn StorageBackend>) -> Result<Self, TalaDbError> {
        Ok(Database {
            backend: Arc::from(backend),
        })
    }

    /// Open an in-memory database (useful for tests).
    pub fn open_in_memory() -> Result<Self, TalaDbError> {
        let backend = RedbBackend::open_in_memory()?;
        Ok(Database {
            backend: Arc::new(backend),
        })
    }

    /// Open a database and run any pending migrations before returning.
    pub fn open_with_migrations(
        path: &Path,
        migrations: &[Migration],
    ) -> Result<Self, TalaDbError> {
        let backend = Arc::new(RedbBackend::open(path)?);
        run_migrations(backend.as_ref(), migrations)?;
        Ok(Database { backend })
    }

    /// Get a collection handle by name.
    pub fn collection(&self, name: &str) -> Collection {
        Collection::new(name, Arc::clone(&self.backend))
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
    let val = u32::from_le_bytes(data[*cursor..end].try_into().unwrap());
    *cursor = end;
    Ok(val)
}

fn read_u64(data: &[u8], cursor: &mut usize) -> Result<u64, TalaDbError> {
    let end = cursor.checked_add(8).ok_or(TalaDbError::InvalidSnapshot)?;
    if end > data.len() {
        return Err(TalaDbError::InvalidSnapshot);
    }
    let val = u64::from_le_bytes(data[*cursor..end].try_into().unwrap());
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
