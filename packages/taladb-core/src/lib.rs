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
pub mod watch;

pub use collection::{Collection, Update};
pub use document::{Document, Value};
pub use engine::{RedbBackend, StorageBackend};
pub use error::ZeroDbError;
pub use migration::{run_migrations, Migration};
pub use query::Filter;

use std::path::Path;
use std::sync::Arc;

/// The main ZeroDB database handle.
pub struct Database {
    backend: Arc<dyn StorageBackend>,
}

impl Database {
    /// Open a file-backed database at the given path.
    pub fn open(path: &Path) -> Result<Self, ZeroDbError> {
        let backend = RedbBackend::open(path)?;
        Ok(Database { backend: Arc::new(backend) })
    }

    /// Open an in-memory database (useful for tests).
    pub fn open_in_memory() -> Result<Self, ZeroDbError> {
        let backend = RedbBackend::open_in_memory()?;
        Ok(Database { backend: Arc::new(backend) })
    }

    /// Open a database and run any pending migrations before returning.
    pub fn open_with_migrations(path: &Path, migrations: &[Migration]) -> Result<Self, ZeroDbError> {
        let backend = Arc::new(RedbBackend::open(path)?);
        run_migrations(backend.as_ref(), migrations)?;
        Ok(Database { backend })
    }

    /// Get a collection handle by name.
    pub fn collection(&self, name: &str) -> Collection {
        Collection::new(name, Arc::clone(&self.backend))
    }
}
