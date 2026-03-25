use std::ops::Bound;
use std::path::Path;
use std::sync::Arc;

use redb::{Database, ReadableTable, TableDefinition};

use crate::error::ZeroDbError;

// ---------------------------------------------------------------------------
// Storage abstraction — lets WASM swap in an OPFS backend
// ---------------------------------------------------------------------------

pub trait StorageBackend: Send + Sync {
    fn begin_write(&self) -> Result<Box<dyn WriteTxn + '_>, ZeroDbError>;
    fn begin_read(&self) -> Result<Box<dyn ReadTxn + '_>, ZeroDbError>;
}

pub trait WriteTxn {
    fn put(&mut self, table: &str, key: &[u8], value: &[u8]) -> Result<(), ZeroDbError>;
    fn delete(&mut self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError>;
    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError>;
    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, ZeroDbError>;
    fn commit(self: Box<Self>) -> Result<(), ZeroDbError>;
}

pub trait ReadTxn {
    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError>;
    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, ZeroDbError>;
    fn scan_all(&self, table: &str) -> Result<Vec<(Vec<u8>, Vec<u8>)>, ZeroDbError>;
}

// ---------------------------------------------------------------------------
// redb backend
// ---------------------------------------------------------------------------

pub struct RedbBackend {
    db: Arc<Database>,
}

impl RedbBackend {
    pub fn open(path: &Path) -> Result<Self, ZeroDbError> {
        let db = Database::create(path)?;
        Ok(RedbBackend { db: Arc::new(db) })
    }

    pub fn open_in_memory() -> Result<Self, ZeroDbError> {
        let db = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())?;
        Ok(RedbBackend { db: Arc::new(db) })
    }
}

impl StorageBackend for RedbBackend {
    fn begin_write(&self) -> Result<Box<dyn WriteTxn + '_>, ZeroDbError> {
        let txn = self.db.begin_write()?;
        Ok(Box::new(RedbWriteTxn { txn }))
    }

    fn begin_read(&self) -> Result<Box<dyn ReadTxn + '_>, ZeroDbError> {
        let txn = self.db.begin_read()?;
        Ok(Box::new(RedbReadTxn { txn }))
    }
}

// --- Write transaction ---

struct RedbWriteTxn {
    txn: redb::WriteTransaction,
}

fn table_def(name: &str) -> TableDefinition<'_, &'static [u8], &'static [u8]> {
    // SAFETY: We extend the lifetime. The name string outlives this call only
    // because redb TableDefinition is used immediately within the txn scope.
    // This is a known pattern for dynamic table names in redb.
    let name: &'static str = unsafe { std::mem::transmute(name) };
    TableDefinition::new(name)
}

impl WriteTxn for RedbWriteTxn {
    fn put(&mut self, table: &str, key: &[u8], value: &[u8]) -> Result<(), ZeroDbError> {
        let mut tbl = self.txn.open_table(table_def(table))?;
        tbl.insert(key, value)?;
        Ok(())
    }

    fn delete(&mut self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError> {
        let mut tbl = self.txn.open_table(table_def(table))?;
        let old = tbl.remove(key)?.map(|v| v.value().to_vec());
        Ok(old)
    }

    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError> {
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
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, ZeroDbError> {
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

    fn commit(self: Box<Self>) -> Result<(), ZeroDbError> {
        self.txn.commit()?;
        Ok(())
    }
}

// --- Read transaction ---

struct RedbReadTxn {
    txn: redb::ReadTransaction,
}

impl ReadTxn for RedbReadTxn {
    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError> {
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
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, ZeroDbError> {
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

    fn scan_all(&self, table: &str) -> Result<Vec<(Vec<u8>, Vec<u8>)>, ZeroDbError> {
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
