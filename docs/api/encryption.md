---
title: Encryption at Rest
description: Transparent AES-GCM-256 encryption for TalaDB using EncryptedBackend. Keys derived via PBKDF2-HMAC-SHA256. Per-write nonces, GCM authentication tags.
---

# Encryption at Rest

TalaDB supports transparent AES-GCM-256 encryption of all stored values through the `EncryptedBackend` wrapper in `taladb-core`. Encryption is opt-in and gated behind a Cargo feature flag so it adds zero code-size overhead when not used.

## How it works

`EncryptedBackend` wraps any `StorageBackend` implementation. On every write, it:

1. Generates a fresh 12-byte nonce using the OS random number generator (`OsRng`)
2. Encrypts the value with AES-GCM-256 using the provided key
3. Prepends the nonce to the ciphertext: `nonce (12 B) || ciphertext || GCM tag (16 B)`
4. Passes the combined bytes to the inner backend

On every read, it splits the stored bytes at offset 12, extracts the nonce, and decrypts. The GCM authentication tag is verified automatically — any tampering or corruption returns an error rather than silently producing wrong data.

Keys are not stored anywhere by TalaDB. The caller is responsible for providing the correct key on every open.

## Enabling the feature

In your `Cargo.toml`:

```toml
[dependencies]
taladb-core = { path = "../taladb-core", features = ["encryption"] }
```

Without the `encryption` feature, `EncryptedBackend::new`, `encrypt`, `decrypt`, and `derive_key` are not compiled in — calling them produces a compile-time error.

## Key derivation

Use `derive_key` to produce a 32-byte key from a user-supplied passphrase and a random salt:

```rust
use taladb_core::crypto::derive_key;

let salt: [u8; 16] = /* 16 random bytes, stored alongside the database */;
let key = derive_key("my-secret-passphrase", &salt, 100_000);
```

`derive_key` runs PBKDF2-HMAC-SHA256 with the given iteration count. The salt must be:

- At least 16 bytes long
- Randomly generated (use `rand::RngCore::fill_bytes` or equivalent)
- Stored alongside the database (not the key — the key is re-derived each time)
- Unique per database — never reuse a salt across different databases

A minimum of 100,000 iterations is recommended. Increase for higher security at the cost of a slower open time.

## Using `EncryptedBackend`

```rust
use std::sync::Arc;
use taladb_core::crypto::{derive_key, EncryptedBackend};
use taladb_core::engine::RedbBackend;
use taladb_core::Database;

// Load or generate the salt (store it in a sidecar file next to the db)
let salt = load_or_create_salt("myapp.salt");

// Re-derive the key from the passphrase — never store the key itself
let key = derive_key("user-passphrase", &salt, 100_000);

// Wrap the redb backend with encryption
let backend = Arc::new(RedbBackend::open("myapp.db")?);
let encrypted_backend = Arc::new(EncryptedBackend::new(backend, key));

// Open the database with the encrypted backend
let db = Database::open_with_backend(encrypted_backend)?;
```

## Generating a salt

```rust
use rand::RngCore;
use aes_gcm::aead::OsRng;

let mut salt = [0u8; 16];
OsRng.fill_bytes(&mut salt);
std::fs::write("myapp.salt", &salt)?;
```

On subsequent opens, load the salt from the sidecar file:

```rust
let salt = std::fs::read("myapp.salt")?;
let key = derive_key("passphrase", &salt, 100_000);
```

## Encryption overhead

| Source | Size |
|---|---|
| Nonce | 12 bytes per value |
| GCM authentication tag | 16 bytes per value |
| Total overhead | 28 bytes per stored value |

There is no per-collection or per-database overhead beyond the storage of individual values.

## What is and is not encrypted

`EncryptedBackend` encrypts **values only**. Keys (document IDs and index entries) are stored in plaintext in the redb B-tree. This means:

- Document content: encrypted ✅
- Document IDs (ULIDs): visible in plaintext ⚠️
- Index field values (encoded in the index key): visible in plaintext ⚠️
- Table names (`docs::users`, `idx::users::email`): visible in plaintext ⚠️

For most applications, protecting document content is sufficient. If you need to also encrypt index keys (to hide which values exist), a different approach is required — for example, deterministic encryption for equality indexes (HMAC of the field value as the key), at the cost of losing range query support.

## Error handling

If the wrong key is provided, decryption fails with a `ZeroDbError::Encryption` error on the first read. The error message does not reveal any information about the correct key.

```rust
match db.collection("users").find(Filter::All) {
    Err(ZeroDbError::Encryption(msg)) => eprintln!("Wrong key or corrupted data: {msg}"),
    Ok(docs) => { /* proceed */ }
    Err(e) => return Err(e),
}
```

## Security notes

- **Do not hard-code passphrases.** Accept them from user input, the system keychain, or a secrets manager.
- **Do not store the derived key.** Re-derive it on each open.
- **Store the salt in a separate file** from the database. This makes it easy to back up the database without the salt (or vice versa) for extra protection.
- **Rotate keys by re-encrypting.** TalaDB does not support in-place key rotation. To change the key, export a snapshot, re-open with the new key, and restore the snapshot.
