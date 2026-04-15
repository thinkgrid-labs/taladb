//! Encryption at rest for TalaDB.
//!
//! Provides an `EncryptedBackend` wrapper that implements `StorageBackend`
//! and transparently encrypts/decrypts all stored values using AES-GCM-256.
//!
//! Binary format (per stored value)
//! ----------------------------------
//! ```text
//! [ version: 1 byte (0x01) ][ nonce: 12 bytes ][ ciphertext + GCM tag (16 B) ]
//! ```
//! The version byte allows future nonce-size changes without silent data
//! corruption — an unknown version byte returns a descriptive error.
//!
//! Authenticated Associated Data (AAD)
//! -------------------------------------
//! Every encryption call binds the value to its storage location by using
//! `"<table>\x00<hex-key>"` as AAD. This prevents a ciphertext from one
//! table/key from being silently moved to another and still decrypting.
//!
//! Thread safety
//! -------------
//! `EncryptedBackend` is `Send + Sync` as long as the inner backend is.
//!
//! Crate features
//! --------------
//! Requires the `encryption` feature flag to pull in `aes-gcm`, `rand`,
//! and `zeroize`. Without it, the module still compiles but `EncryptedBackend`
//! is gated behind a compile error.

use std::ops::Bound;
use std::sync::Arc;

use crate::engine::{KvPairs, ReadTxn, StorageBackend, WriteTxn};
use crate::error::TalaDbError;

// ---------------------------------------------------------------------------
// AES-GCM-256 primitives
// ---------------------------------------------------------------------------

// Encryption primitives require `features = ["encryption"]` in Cargo.toml.
// When enabled, Cargo pulls in: aes-gcm 0.10, rand 0.8, pbkdf2 0.12,
// hmac 0.12, sha2 0.10, zeroize 1.7.

/// Version tag prepended to every encrypted value.
/// Increment this and add a migration path if the format ever changes.
const CRYPTO_FORMAT_V1: u8 = 0x01;

/// AES-GCM nonce length for format version 1.
const NONCE_LEN_V1: usize = 12;

/// Minimum PBKDF2-HMAC-SHA256 iteration count (OWASP 2023 recommendation).
pub const MIN_PBKDF2_ITERATIONS: u32 = 100_000;

/// A 256-bit encryption key.
///
/// When the `encryption` feature is enabled, this is a `Zeroizing` wrapper so
/// the key bytes are overwritten on drop, preventing them from lingering in
/// memory.
#[cfg(feature = "encryption")]
pub type EncryptionKey = zeroize::Zeroizing<[u8; 32]>;

/// Stub type used when the `encryption` feature is disabled.
#[cfg(not(feature = "encryption"))]
pub type EncryptionKey = [u8; 32];

// ---------------------------------------------------------------------------
// Internal helper: build AAD from table name + raw key bytes
// ---------------------------------------------------------------------------

/// Construct the Authenticated Associated Data string for a given
/// `(table, key)` pair.  Using AAD prevents a ciphertext from being silently
/// relocated to a different table or key slot.
fn make_aad(table: &str, key: &[u8]) -> Vec<u8> {
    // Format: "<table>\0<hex-encoded key bytes>"
    // The null byte separator ensures the table name cannot be confused with
    // the start of the hex key (table names are never null-terminated).
    let mut aad = table.as_bytes().to_vec();
    aad.push(0x00);
    for b in key {
        aad.push(b"0123456789abcdef"[(b >> 4) as usize]);
        aad.push(b"0123456789abcdef"[(b & 0xf) as usize]);
    }
    aad
}

// ---------------------------------------------------------------------------
// encrypt / decrypt — public primitives
// ---------------------------------------------------------------------------

/// Encrypt `plaintext` with AES-GCM-256, binding the result to `(table, key)`.
///
/// Returns `[0x01][nonce (12 B)][ciphertext][GCM tag (16 B)]`.
///
/// # Errors
/// Returns `TalaDbError::Encryption` on failure.
pub fn encrypt(
    enc_key: &EncryptionKey,
    table: &str,
    key: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, TalaDbError> {
    #[cfg(feature = "encryption")]
    {
        use aes_gcm::aead::{Aead, KeyInit, OsRng};
        use aes_gcm::{Aes256Gcm, Nonce};
        use rand::RngCore;

        let cipher = Aes256Gcm::new_from_slice(enc_key.as_ref())
            .map_err(|e| TalaDbError::Encryption(e.to_string()))?;

        let mut nonce_bytes = [0u8; NONCE_LEN_V1];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let aad = make_aad(table, key);
        let payload = aes_gcm::aead::Payload {
            msg: plaintext,
            aad: &aad,
        };
        let ciphertext = cipher
            .encrypt(nonce, payload)
            .map_err(|e| TalaDbError::Encryption(e.to_string()))?;

        let mut out = Vec::with_capacity(1 + NONCE_LEN_V1 + ciphertext.len());
        out.push(CRYPTO_FORMAT_V1);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }
    #[cfg(not(feature = "encryption"))]
    {
        let _ = (enc_key, table, key, plaintext);
        Err(TalaDbError::Encryption(
            "encrypt() called but the `encryption` feature is not enabled; \
             enable it in Cargo.toml: taladb-core = { features = [\"encryption\"] }"
                .into(),
        ))
    }
}

/// Decrypt a value produced by `encrypt`, verifying that it belongs to `(table, key)`.
///
/// # Errors
/// Returns `TalaDbError::Encryption` on authentication failure, unknown version,
/// or bad input.
pub fn decrypt(
    enc_key: &EncryptionKey,
    table: &str,
    key: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, TalaDbError> {
    #[cfg(feature = "encryption")]
    {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};

        // Minimum: 1 version byte + 12 nonce bytes + 16 GCM tag bytes = 29
        if data.len() < 1 + NONCE_LEN_V1 + 16 {
            return Err(TalaDbError::Encryption("ciphertext too short".into()));
        }

        let version = data[0];
        if version != CRYPTO_FORMAT_V1 {
            return Err(TalaDbError::Encryption(format!(
                "unsupported encrypted-value format version {version:#04x}; \
                 expected {CRYPTO_FORMAT_V1:#04x}"
            )));
        }

        let nonce_bytes = &data[1..1 + NONCE_LEN_V1];
        let ciphertext = &data[1 + NONCE_LEN_V1..];

        let cipher = Aes256Gcm::new_from_slice(enc_key.as_ref())
            .map_err(|e| TalaDbError::Encryption(e.to_string()))?;
        let nonce = Nonce::from_slice(nonce_bytes);

        let aad = make_aad(table, key);
        let payload = aes_gcm::aead::Payload {
            msg: ciphertext,
            aad: &aad,
        };
        cipher
            .decrypt(nonce, payload)
            .map_err(|e| TalaDbError::Encryption(e.to_string()))
    }
    #[cfg(not(feature = "encryption"))]
    {
        let _ = (enc_key, table, key, data);
        Err(TalaDbError::Encryption(
            "decrypt() called but the `encryption` feature is not enabled; \
             enable it in Cargo.toml: taladb-core = { features = [\"encryption\"] }"
                .into(),
        ))
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
    fn begin_write(&self) -> Result<Box<dyn WriteTxn + '_>, TalaDbError> {
        let inner_txn = self.inner.begin_write()?;
        Ok(Box::new(EncryptedWriteTxn {
            inner: inner_txn,
            key: &self.key,
        }))
    }

    fn begin_read(&self) -> Result<Box<dyn ReadTxn + '_>, TalaDbError> {
        let inner_txn = self.inner.begin_read()?;
        Ok(Box::new(EncryptedReadTxn {
            inner: inner_txn,
            key: &self.key,
        }))
    }
}

// ---------------------------------------------------------------------------
// EncryptedWriteTxn
// ---------------------------------------------------------------------------

struct EncryptedWriteTxn<'a> {
    inner: Box<dyn WriteTxn + 'a>,
    key: &'a EncryptionKey,
}

impl<'a> WriteTxn for EncryptedWriteTxn<'a> {
    fn put(&mut self, table: &str, key: &[u8], value: &[u8]) -> Result<(), TalaDbError> {
        let encrypted = encrypt(self.key, table, key, value)?;
        self.inner.put(table, key, &encrypted)
    }

    fn delete(&mut self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError> {
        self.inner.delete(table, key)
    }

    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError> {
        match self.inner.get(table, key)? {
            Some(data) => Ok(Some(decrypt(self.key, table, key, &data)?)),
            None => Ok(None),
        }
    }

    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, TalaDbError> {
        let raw = self.inner.range(table, start, end)?;
        raw.into_iter()
            .map(|(k, v)| {
                let plain = decrypt(self.key, table, &k, &v)?;
                Ok((k, plain))
            })
            .collect()
    }

    fn commit(self: Box<Self>) -> Result<(), TalaDbError> {
        self.inner.commit()
    }
}

// ---------------------------------------------------------------------------
// EncryptedReadTxn
// ---------------------------------------------------------------------------

struct EncryptedReadTxn<'a> {
    inner: Box<dyn ReadTxn + 'a>,
    key: &'a EncryptionKey,
}

impl<'a> ReadTxn for EncryptedReadTxn<'a> {
    fn get(&self, table: &str, key: &[u8]) -> Result<Option<Vec<u8>>, TalaDbError> {
        match self.inner.get(table, key)? {
            Some(data) => Ok(Some(decrypt(self.key, table, key, &data)?)),
            None => Ok(None),
        }
    }

    fn range(
        &self,
        table: &str,
        start: Bound<&[u8]>,
        end: Bound<&[u8]>,
    ) -> Result<KvPairs, TalaDbError> {
        let raw = self.inner.range(table, start, end)?;
        raw.into_iter()
            .map(|(k, v)| {
                let plain = decrypt(self.key, table, &k, &v)?;
                Ok((k, plain))
            })
            .collect()
    }

    fn scan_all(&self, table: &str) -> Result<KvPairs, TalaDbError> {
        let raw = self.inner.scan_all(table)?;
        raw.into_iter()
            .map(|(k, v)| {
                let plain = decrypt(self.key, table, &k, &v)?;
                Ok((k, plain))
            })
            .collect()
    }

    fn list_tables(&self) -> Result<Vec<String>, TalaDbError> {
        self.inner.list_tables()
    }
}

// ---------------------------------------------------------------------------
// Key derivation helpers
// ---------------------------------------------------------------------------

/// Derive a 256-bit key from a passphrase using PBKDF2-HMAC-SHA256.
///
/// `salt` should be at least 16 random bytes, unique per database.
/// `iterations` must be at least [`MIN_PBKDF2_ITERATIONS`] (100 000).
///
/// Returns a zeroizing 32-byte key suitable for `EncryptedBackend::new`.
///
/// **Requires** the `encryption` feature flag.
pub fn derive_key(
    passphrase: &str,
    salt: &[u8],
    iterations: u32,
) -> Result<EncryptionKey, TalaDbError> {
    #[cfg(feature = "encryption")]
    {
        use pbkdf2::pbkdf2_hmac;
        use sha2::Sha256;

        if iterations < MIN_PBKDF2_ITERATIONS {
            return Err(TalaDbError::Config(format!(
                "PBKDF2 iterations too low ({iterations}); \
                 minimum is {MIN_PBKDF2_ITERATIONS}"
            )));
        }

        let mut key = zeroize::Zeroizing::new([0u8; 32]);
        pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, iterations, key.as_mut());
        Ok(key)
    }
    #[cfg(not(feature = "encryption"))]
    {
        let _ = (passphrase, salt, iterations);
        Err(TalaDbError::Encryption(
            "derive_key() called but the `encryption` feature is not enabled; \
             enable it in Cargo.toml: taladb-core = { features = [\"encryption\"] }"
                .into(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(all(test, feature = "encryption"))]
mod tests {
    use super::*;

    fn test_key() -> EncryptionKey {
        zeroize::Zeroizing::new([0x42u8; 32])
    }

    #[test]
    fn round_trip() {
        let key = test_key();
        let plaintext = b"hello world";
        let ciphertext = encrypt(&key, "my_table", b"doc_id_1", plaintext).unwrap();
        let decrypted = decrypt(&key, "my_table", b"doc_id_1", &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_key_fails() {
        let key1 = test_key();
        let key2 = zeroize::Zeroizing::new([0x99u8; 32]);
        let ct = encrypt(&key1, "t", b"k", b"secret").unwrap();
        assert!(decrypt(&key2, "t", b"k", &ct).is_err());
    }

    #[test]
    fn aad_table_mismatch_fails() {
        let key = test_key();
        let ct = encrypt(&key, "table_a", b"key1", b"data").unwrap();
        // Moving ciphertext to a different table must fail authentication.
        assert!(decrypt(&key, "table_b", b"key1", &ct).is_err());
    }

    #[test]
    fn aad_key_mismatch_fails() {
        let key = test_key();
        let ct = encrypt(&key, "table_a", b"key1", b"data").unwrap();
        // Same table, different storage key — must fail authentication.
        assert!(decrypt(&key, "table_a", b"key2", &ct).is_err());
    }

    #[test]
    fn unknown_version_fails() {
        let key = test_key();
        let mut ct = encrypt(&key, "t", b"k", b"data").unwrap();
        ct[0] = 0xFF; // corrupt version byte
        let err = decrypt(&key, "t", b"k", &ct).unwrap_err();
        assert!(err.to_string().contains("unsupported encrypted-value format version"));
    }

    #[test]
    fn truncated_ciphertext_fails() {
        let key = test_key();
        assert!(decrypt(&key, "t", b"k", &[]).is_err());
        assert!(decrypt(&key, "t", b"k", &[CRYPTO_FORMAT_V1; 10]).is_err());
    }

    #[test]
    fn derive_key_enforces_min_iterations() {
        let err = derive_key("pass", b"salt1234567890ab", 999).unwrap_err();
        assert!(err.to_string().contains("iterations too low"));
    }

    #[test]
    fn derive_key_at_min_iterations_succeeds() {
        let key = derive_key("pass", b"salt1234567890ab", MIN_PBKDF2_ITERATIONS).unwrap();
        assert_eq!(key.len(), 32);
    }
}
