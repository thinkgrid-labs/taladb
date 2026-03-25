//! Encryption at rest for TalaDB.
//!
//! Provides an `EncryptedBackend` wrapper that implements `StorageBackend`
//! and transparently encrypts/decrypts all stored values using AES-GCM-256.
//!
//! Keys / Nonces
//! -------------
//! - Key   : 32 bytes (256-bit), provided by the caller.
//! - Nonce : 12 bytes, randomly generated per write and prepended to the
//!   ciphertext. Total overhead per value: 12 bytes nonce + 16 bytes
//!   GCM tag = 28 bytes.
//!
//! Thread safety
//! -------------
//! `EncryptedBackend` is `Send + Sync` as long as the inner backend is.
//!
//! Crate features
//! --------------
//! Requires the `encryption` feature flag to pull in `aes-gcm` and `rand`.
//! Without it, the module still compiles but `EncryptedBackend::new` is
//! gated behind a compile error.

use std::ops::Bound;
use std::sync::Arc;

use crate::engine::{KvPairs, ReadTxn, StorageBackend, WriteTxn};
use crate::error::ZeroDbError;

// ---------------------------------------------------------------------------
// AES-GCM-256 primitives
// ---------------------------------------------------------------------------

// Encryption primitives require `features = ["encryption"]` in Cargo.toml.
// When enabled, Cargo pulls in: aes-gcm 0.10, rand 0.8, pbkdf2 0.12, hmac 0.12, sha2 0.10.

/// A 256-bit encryption key.
pub type EncryptionKey = [u8; 32];

/// Encrypt `plaintext` with AES-GCM-256.
/// Returns `nonce (12 B) || ciphertext || tag (16 B)`.
///
/// # Errors
/// Returns `ZeroDbError::Encryption` on failure.
pub fn encrypt(key: &EncryptionKey, plaintext: &[u8]) -> Result<Vec<u8>, ZeroDbError> {
    #[cfg(feature = "encryption")]
    {
        use aes_gcm::aead::{Aead, KeyInit, OsRng};
        use aes_gcm::{Aes256Gcm, Nonce};
        use rand::RngCore;

        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|e| ZeroDbError::Encryption(e.to_string()))?;

        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| ZeroDbError::Encryption(e.to_string()))?;

        let mut out = Vec::with_capacity(12 + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }
    #[cfg(not(feature = "encryption"))]
    {
        let _ = (key, plaintext);
        panic!(
            "TalaDB: encrypt() called but the `encryption` feature is not enabled. \
             Enable it in Cargo.toml: taladb-core = {{ features = [\"encryption\"] }}"
        );
    }
}

/// Decrypt a value produced by `encrypt`.
///
/// # Errors
/// Returns `ZeroDbError::Encryption` on authentication failure or bad input.
pub fn decrypt(key: &EncryptionKey, data: &[u8]) -> Result<Vec<u8>, ZeroDbError> {
    #[cfg(feature = "encryption")]
    {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};

        if data.len() < 12 {
            return Err(ZeroDbError::Encryption("ciphertext too short".into()));
        }
        let (nonce_bytes, ciphertext) = data.split_at(12);
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|e| ZeroDbError::Encryption(e.to_string()))?;
        let nonce = Nonce::from_slice(nonce_bytes);

        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| ZeroDbError::Encryption(e.to_string()))
    }
    #[cfg(not(feature = "encryption"))]
    {
        let _ = (key, data);
        panic!(
            "TalaDB: decrypt() called but the `encryption` feature is not enabled. \
             Enable it in Cargo.toml: taladb-core = {{ features = [\"encryption\"] }}"
        );
    }
}

// ---------------------------------------------------------------------------
// EncryptedBackend — wraps any StorageBackend and encrypts all values
// ---------------------------------------------------------------------------

pub struct EncryptedBackend {
    inner: Arc<dyn StorageBackend>,
    key: EncryptionKey,
}

impl EncryptedBackend {
    /// Create an encrypted backend.
    ///
    /// **Requires** the `encryption` feature flag. Without it this function
    /// does not exist, making misconfiguration a compile-time error.
    #[cfg(feature = "encryption")]
    pub fn new(inner: Arc<dyn StorageBackend>, key: EncryptionKey) -> Self {
        EncryptedBackend { inner, key }
    }
}

impl StorageBackend for EncryptedBackend {
    fn begin_write(&self) -> Result<Box<dyn WriteTxn + '_>, ZeroDbError> {
        let inner_txn = self.inner.begin_write()?;
        Ok(Box::new(EncryptedWriteTxn { inner: inner_txn, key: self.key }))
    }

    fn begin_read(&self) -> Result<Box<dyn ReadTxn + '_>, ZeroDbError> {
        let inner_txn = self.inner.begin_read()?;
        Ok(Box::new(EncryptedReadTxn { inner: inner_txn, key: self.key }))
    }
}

// ---------------------------------------------------------------------------
// EncryptedWriteTxn
// ---------------------------------------------------------------------------

struct EncryptedWriteTxn<'a> {
    inner: Box<dyn WriteTxn + 'a>,
    key: EncryptionKey,
}

impl<'a> WriteTxn for EncryptedWriteTxn<'a> {
    fn put(&mut self, table: &str, key: &[u8], value: &[u8]) -> Result<(), ZeroDbError> {
        let encrypted = encrypt(&self.key, value)?;
        self.inner.put(table, key, &encrypted)
    }

    fn delete(&mut self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError> {
        self.inner.delete(table, key)
    }

    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError> {
        match self.inner.get(table, key)? {
            Some(data) => Ok(Some(decrypt(&self.key, &data)?)),
            None => Ok(None),
        }
    }

    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, ZeroDbError> {
        let raw = self.inner.range(table, start, end)?;
        raw.into_iter()
            .map(|(k, v)| Ok((k, decrypt(&self.key, &v)?)))
            .collect()
    }

    fn commit(self: Box<Self>) -> Result<(), ZeroDbError> {
        self.inner.commit()
    }
}

// ---------------------------------------------------------------------------
// EncryptedReadTxn
// ---------------------------------------------------------------------------

struct EncryptedReadTxn<'a> {
    inner: Box<dyn ReadTxn + 'a>,
    key: EncryptionKey,
}

impl<'a> ReadTxn for EncryptedReadTxn<'a> {
    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, ZeroDbError> {
        match self.inner.get(table, key)? {
            Some(data) => Ok(Some(decrypt(&self.key, &data)?)),
            None => Ok(None),
        }
    }

    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, ZeroDbError> {
        let raw = self.inner.range(table, start, end)?;
        raw.into_iter()
            .map(|(k, v)| Ok((k, decrypt(&self.key, &v)?)))
            .collect()
    }

    fn scan_all(&self, table: &str) -> Result<KvPairs, ZeroDbError> {
        let raw = self.inner.scan_all(table)?;
        raw.into_iter()
            .map(|(k, v)| Ok((k, decrypt(&self.key, &v)?)))
            .collect()
    }

    fn list_tables(&self) -> Result<Vec<String>, ZeroDbError> {
        self.inner.list_tables()
    }
}

// ---------------------------------------------------------------------------
// Key derivation helpers
// ---------------------------------------------------------------------------

/// Derive a 256-bit key from a passphrase using PBKDF2-HMAC-SHA256.
/// `salt` should be at least 16 random bytes, unique per database.
/// `iterations` recommended minimum: 100_000.
///
/// Returns a 32-byte key suitable for `EncryptedBackend::new`.
///
/// **Requires** the `encryption` feature flag.
pub fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> EncryptionKey {
    #[cfg(feature = "encryption")]
    {
        use hmac::Hmac;
        use pbkdf2::pbkdf2_hmac;
        use sha2::Sha256;

        let mut key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, iterations, &mut key);
        key
    }
    #[cfg(not(feature = "encryption"))]
    {
        let _ = (passphrase, salt, iterations);
        panic!(
            "TalaDB: derive_key() called but the `encryption` feature is not enabled. \
             Enable it in Cargo.toml: taladb-core = {{ features = [\"encryption\"] }}"
        );
    }
}
