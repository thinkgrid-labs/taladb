use thiserror::Error;

#[derive(Debug, Error)]
pub enum TalaDbError {
    #[error("storage error: {0}")]
    Storage(String),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("document not found")]
    NotFound,

    #[error("invalid filter: {0}")]
    InvalidFilter(String),

    #[error("index already exists: {0}")]
    IndexExists(String),

    #[error("index not found: {0}")]
    IndexNotFound(String),

    #[error("migration error: {0}")]
    Migration(String),

    #[error("type error: expected {expected}, got {got}")]
    TypeError { expected: String, got: String },

    #[error("encryption error: {0}")]
    Encryption(String),

    #[error("watch channel closed")]
    WatchClosed,

    #[error("watch subscriber dropped due to full channel")]
    WatchBackpressure,

    #[error("invalid or corrupt snapshot data")]
    InvalidSnapshot,

    #[error("vector index not found: {0}")]
    VectorIndexNotFound(String),

    #[error("vector dimension mismatch: index expects {expected}, got {got}")]
    VectorDimensionMismatch { expected: usize, got: usize },
}

impl From<redb::DatabaseError> for TalaDbError {
    fn from(e: redb::DatabaseError) -> Self {
        TalaDbError::Storage(e.to_string())
    }
}

impl From<redb::Error> for TalaDbError {
    fn from(e: redb::Error) -> Self {
        TalaDbError::Storage(e.to_string())
    }
}

impl From<redb::TransactionError> for TalaDbError {
    fn from(e: redb::TransactionError) -> Self {
        TalaDbError::Storage(e.to_string())
    }
}

impl From<redb::TableError> for TalaDbError {
    fn from(e: redb::TableError) -> Self {
        TalaDbError::Storage(e.to_string())
    }
}

impl From<redb::StorageError> for TalaDbError {
    fn from(e: redb::StorageError) -> Self {
        TalaDbError::Storage(e.to_string())
    }
}

impl From<redb::CommitError> for TalaDbError {
    fn from(e: redb::CommitError) -> Self {
        TalaDbError::Storage(e.to_string())
    }
}

impl From<postcard::Error> for TalaDbError {
    fn from(e: postcard::Error) -> Self {
        TalaDbError::Serialization(e.to_string())
    }
}
