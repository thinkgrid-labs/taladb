use thiserror::Error;

#[derive(Debug, Error)]
pub enum ZeroDbError {
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

    #[error("invalid or corrupt snapshot data")]
    InvalidSnapshot,
}

impl From<redb::DatabaseError> for ZeroDbError {
    fn from(e: redb::DatabaseError) -> Self {
        ZeroDbError::Storage(e.to_string())
    }
}

impl From<redb::Error> for ZeroDbError {
    fn from(e: redb::Error) -> Self {
        ZeroDbError::Storage(e.to_string())
    }
}

impl From<redb::TransactionError> for ZeroDbError {
    fn from(e: redb::TransactionError) -> Self {
        ZeroDbError::Storage(e.to_string())
    }
}

impl From<redb::TableError> for ZeroDbError {
    fn from(e: redb::TableError) -> Self {
        ZeroDbError::Storage(e.to_string())
    }
}

impl From<redb::StorageError> for ZeroDbError {
    fn from(e: redb::StorageError) -> Self {
        ZeroDbError::Storage(e.to_string())
    }
}

impl From<redb::CommitError> for ZeroDbError {
    fn from(e: redb::CommitError) -> Self {
        ZeroDbError::Storage(e.to_string())
    }
}

impl From<postcard::Error> for ZeroDbError {
    fn from(e: postcard::Error) -> Self {
        ZeroDbError::Serialization(e.to_string())
    }
}
