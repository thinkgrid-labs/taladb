use std::ops::Bound;
use std::path::Path;
use std::sync::Arc;

use redb::{Database, ReadableTable, TableDefinition, TableHandle};

use crate::error::TalaDbError;

// ---------------------------------------------------------------------------
// Storage abstraction — lets WASM swap in an OPFS backend
// ---------------------------------------------------------------------------

/// Key-value pairs returned from range/scan operations.
pub type KvPairs = Vec<(Vec<u8>, Vec<u8>)>;

pub trait StorageBackend: Send + Sync {
    fn begin_write(&self) -> Result<Box<dyn WriteTxn + '_>, TalaDbError>;
    fn begin_read(&self) -> Result<Box<dyn ReadTxn + '_>, TalaDbError>;
}

pub trait WriteTxn {
    fn put(&mut self, table: &str, key: &[u8], value: &[u8]) -> Result<(), TalaDbError>;
    fn delete(&mut self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError>;
    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError>;
    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, TalaDbError>;
    fn commit(self: Box<Self>) -> Result<(), TalaDbError>;
}

pub trait ReadTxn {
    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError>;
    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, TalaDbError>;
    fn scan_all(&self, table: &str) -> Result<KvPairs, TalaDbError>;
    /// Return the names of every table in the database.
    fn list_tables(&self) -> Result<Vec<String>, TalaDbError>;
}

// ---------------------------------------------------------------------------
// redb backend
// ---------------------------------------------------------------------------

pub struct RedbBackend {
    db: Arc<Database>,
}

impl RedbBackend {
    pub fn open(path: &Path) -> Result<Self, TalaDbError> {
        let db = Database::create(path)?;
        Ok(RedbBackend { db: Arc::new(db) })
    }

    pub fn open_in_memory() -> Result<Self, TalaDbError> {
        let db = Database::builder().create_with_backend(redb::backends::InMemoryBackend::new())?;
        Ok(RedbBackend { db: Arc::new(db) })
    }

    /// Open a database using any `redb::StorageBackend` (e.g. OPFS in WASM).
    pub fn open_with_redb_backend<B: redb::StorageBackend + 'static>(
        backend: B,
    ) -> Result<Self, TalaDbError> {
        let db = Database::builder().create_with_backend(backend)?;
        Ok(RedbBackend { db: Arc::new(db) })
    }
}

impl StorageBackend for RedbBackend {
    fn begin_write(&self) -> Result<Box<dyn WriteTxn + '_>, TalaDbError> {
        let txn = self.db.begin_write()?;
        Ok(Box::new(RedbWriteTxn { txn }))
    }

    fn begin_read(&self) -> Result<Box<dyn ReadTxn + '_>, TalaDbError> {
        let txn = self.db.begin_read()?;
        Ok(Box::new(RedbReadTxn { txn }))
    }
}

// --- Write transaction ---

struct RedbWriteTxn {
    txn: redb::WriteTransaction,
}

/// Maximum number of distinct table names that may be interned per process.
/// Each name is `Box::leak`ed exactly once (~50–200 bytes each), so this
/// caps total memory growth from interning at well under a megabyte.
const MAX_INTERNED_NAMES: usize = 4096;

/// Intern a table name string so we can hand a `&'static str` to redb's
/// `TableDefinition::new`, which requires `'static`.
///
/// Each unique name is leaked exactly once; subsequent calls return the same
/// pointer. The intern set is bounded by [`MAX_INTERNED_NAMES`] to prevent
/// unbounded memory growth when a workload generates many distinct names.
///
/// # Panics
/// Panics if more than `MAX_INTERNED_NAMES` distinct names are interned in a
/// single process — this indicates a programming error (e.g. dynamically
/// generating thousands of collection names).
fn intern_name(name: &str) -> &'static str {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    static INTERNED: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let set = INTERNED.get_or_init(|| Mutex::new(HashSet::new()));
    // Recover from a poisoned mutex: the only content is interned strings
    // (immutable &'static str), so the state is always valid even after panic.
    let mut guard = set.lock().unwrap_or_else(|p| {
        eprintln!("[taladb] intern_name: mutex was poisoned; recovering");
        p.into_inner()
    });
    if let Some(&existing) = guard.get(name) {
        return existing;
    }
    assert!(
        guard.len() < MAX_INTERNED_NAMES,
        "[taladb] intern_name: exceeded {MAX_INTERNED_NAMES} interned table names; \
         avoid dynamically generating unbounded collection or index names"
    );
    let leaked: &'static str = Box::leak(name.to_string().into_boxed_str());
    guard.insert(leaked);
    leaked
}

fn table_def(name: &str) -> TableDefinition<'static, &'static [u8], &'static [u8]> {
    TableDefinition::new(intern_name(name))
}

impl WriteTxn for RedbWriteTxn {
    fn put(&mut self, table: &str, key: &[u8], value: &[u8]) -> Result<(), TalaDbError> {
        let mut tbl = self.txn.open_table(table_def(table))?;
        tbl.insert(key, value)?;
        Ok(())
    }

    fn delete(&mut self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError> {
        let mut tbl = self.txn.open_table(table_def(table))?;
        let old = tbl.remove(key)?.map(|v| v.value().to_vec());
        Ok(old)
    }

    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError> {
        match self.txn.open_table(table_def(table)) {
            Ok(tbl) => Ok(tbl.get(key)?.map(|v| v.value().to_vec())),
            Err(redb::TableError::TableDoesNotExist(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, TalaDbError> {
        match self.txn.open_table(table_def(table)) {
            Ok(tbl) => {
                let iter = tbl.range::<&[u8]>((start, end))?;
                let mut out = Vec::new();
                for entry in iter {
                    let (k, v) = entry?;
                    out.push((k.value().to_vec(), v.value().to_vec()));
                }
                Ok(out)
            }
            Err(redb::TableError::TableDoesNotExist(_)) => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }

    fn commit(self: Box<Self>) -> Result<(), TalaDbError> {
        self.txn.commit()?;
        Ok(())
    }
}

// --- Read transaction ---

struct RedbReadTxn {
    txn: redb::ReadTransaction,
}

impl ReadTxn for RedbReadTxn {
    fn list_tables(&self) -> Result<Vec<String>, TalaDbError> {
        let names = self
            .txn
            .list_tables()?
            .map(|t| t.name().to_string())
            .collect();
        Ok(names)
    }

    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError> {
        match self.txn.open_table(table_def(table)) {
            Ok(tbl) => Ok(tbl.get(key)?.map(|v| v.value().to_vec())),
            Err(redb::TableError::TableDoesNotExist(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, TalaDbError> {
        match self.txn.open_table(table_def(table)) {
            Ok(tbl) => {
                let iter = tbl.range::<&[u8]>((start, end))?;
                let mut out = Vec::new();
                for entry in iter {
                    let (k, v) = entry?;
                    out.push((k.value().to_vec(), v.value().to_vec()));
                }
                Ok(out)
            }
            Err(redb::TableError::TableDoesNotExist(_)) => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }

    fn scan_all(&self, table: &str) -> Result<KvPairs, TalaDbError> {
        match self.txn.open_table(table_def(table)) {
            Ok(tbl) => {
                let iter = tbl.iter()?;
                let mut out = Vec::new();
                for entry in iter {
                    let (k, v) = entry?;
                    out.push((k.value().to_vec(), v.value().to_vec()));
                }
                Ok(out)
            }
            Err(redb::TableError::TableDoesNotExist(_)) => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }
}
