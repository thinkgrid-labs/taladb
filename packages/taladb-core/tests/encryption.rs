//! Integration tests for AES-GCM-256 encryption at rest.
//!
//! Requires `--features encryption` to compile and run.

#![cfg(feature = "encryption")]

use std::sync::Arc;

use taladb_core::crypto::{decrypt, derive_key, encrypt, EncryptedBackend};
use taladb_core::document::Value;
use taladb_core::engine::RedbBackend;
use taladb_core::{Database, Filter};

fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}
fn i(n: i64) -> Value {
    Value::Int(n)
}

// ---------------------------------------------------------------------------
// Low-level encrypt / decrypt
// ---------------------------------------------------------------------------

#[test]
fn encrypt_decrypt_round_trip() {
    let key = [0u8; 32];
    let plaintext = b"Hello, TalaDB encryption!";
    let ciphertext = encrypt(&key, plaintext).unwrap();
    assert_ne!(
        ciphertext.as_slice(),
        plaintext,
        "ciphertext must differ from plaintext"
    );
    let recovered = decrypt(&key, &ciphertext).unwrap();
    assert_eq!(recovered.as_slice(), plaintext);
}

#[test]
fn decrypt_with_wrong_key_fails() {
    let key_a = [0u8; 32];
    let key_b = [1u8; 32];
    let ciphertext = encrypt(&key_a, b"secret data").unwrap();
    let result = decrypt(&key_b, &ciphertext);
    assert!(result.is_err(), "decryption with wrong key must fail");
}

#[test]
fn decrypt_truncated_ciphertext_fails() {
    let key = [0u8; 32];
    let result = decrypt(&key, &[0u8; 5]); // shorter than 12-byte nonce
    assert!(result.is_err(), "truncated ciphertext must return an error");
}

#[test]
fn encrypt_is_nondeterministic() {
    // Each call generates a fresh random nonce — same plaintext produces different ciphertext
    let key = [42u8; 32];
    let plaintext = b"same message";
    let c1 = encrypt(&key, plaintext).unwrap();
    let c2 = encrypt(&key, plaintext).unwrap();
    assert_ne!(
        c1, c2,
        "two encryptions of the same plaintext must differ (random nonces)"
    );
}

// ---------------------------------------------------------------------------
// derive_key
// ---------------------------------------------------------------------------

#[test]
fn derive_key_is_deterministic() {
    let k1 = derive_key("passphrase", b"salt1234", 1_000).unwrap();
    let k2 = derive_key("passphrase", b"salt1234", 1_000).unwrap();
    assert_eq!(k1, k2, "same passphrase + salt must derive the same key");
}

#[test]
fn derive_key_differs_with_different_passphrase() {
    let k1 = derive_key("passphrase_a", b"salt", 1_000).unwrap();
    let k2 = derive_key("passphrase_b", b"salt", 1_000).unwrap();
    assert_ne!(k1, k2);
}

#[test]
fn derive_key_differs_with_different_salt() {
    let k1 = derive_key("passphrase", b"salt_a", 1_000).unwrap();
    let k2 = derive_key("passphrase", b"salt_b", 1_000).unwrap();
    assert_ne!(k1, k2);
}

// ---------------------------------------------------------------------------
// EncryptedBackend — full CRUD through Database
// ---------------------------------------------------------------------------

fn encrypted_db(key: [u8; 32]) -> Database {
    let inner = Arc::new(RedbBackend::open_in_memory().unwrap());
    let enc = Box::new(EncryptedBackend::new(inner, key));
    Database::open_with_backend(enc).unwrap()
}

#[test]
fn encrypted_backend_insert_and_find() {
    let key = [7u8; 32];
    let db = encrypted_db(key);
    let col = db.collection("secrets");

    col.insert(vec![("secret".into(), s("my password"))])
        .unwrap();

    let results = col
        .find(Filter::Eq("secret".into(), s("my password")))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("secret"), Some(&s("my password")));
}

#[test]
fn encrypted_backend_update_and_delete() {
    let key = [8u8; 32];
    let db = encrypted_db(key);
    let col = db.collection("data");

    col.insert(vec![("value".into(), i(1))]).unwrap();

    let updated = col
        .update_one(
            Filter::Eq("value".into(), i(1)),
            taladb_core::Update::Set(vec![("value".into(), i(2))]),
        )
        .unwrap();
    assert!(updated);

    let results = col.find(Filter::Eq("value".into(), i(2))).unwrap();
    assert_eq!(results.len(), 1);

    let deleted = col.delete_one(Filter::Eq("value".into(), i(2))).unwrap();
    assert!(deleted);
    assert_eq!(col.find(Filter::All).unwrap().len(), 0);
}

#[test]
fn encrypted_backend_snapshot_round_trip() {
    let key = [9u8; 32];
    let db = encrypted_db(key);
    let col = db.collection("notes");

    col.insert(vec![("body".into(), s("encrypted note"))])
        .unwrap();

    let snapshot = db.export_snapshot().unwrap();

    // Restore from snapshot into a fresh encrypted backend
    let inner2 = Arc::new(RedbBackend::open_in_memory().unwrap());
    let enc2 = Box::new(EncryptedBackend::new(inner2, key));
    let db2 = Database::open_with_backend(enc2).unwrap();

    // Restore directly into in-memory (snapshot stores plaintext-after-decrypt)
    let db3 = Database::restore_from_snapshot(&snapshot).unwrap();
    let col3 = db3.collection("notes");
    let results = col3.find(Filter::All).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("body"), Some(&s("encrypted note")));
}

#[test]
fn encrypted_backend_index_works() {
    let key = [10u8; 32];
    let db = encrypted_db(key);
    let col = db.collection("users");

    col.create_index("email").unwrap();
    col.insert(vec![
        ("email".into(), s("alice@example.com")),
        ("age".into(), i(30)),
    ])
    .unwrap();
    col.insert(vec![
        ("email".into(), s("bob@example.com")),
        ("age".into(), i(25)),
    ])
    .unwrap();

    let results = col
        .find(Filter::Eq("email".into(), s("alice@example.com")))
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].get("age"), Some(&i(30)));
}

#[test]
fn encrypted_backend_multiple_docs() {
    let key = [11u8; 32];
    let db = encrypted_db(key);
    let col = db.collection("items");

    for n in 0..20i64 {
        col.insert(vec![("n".into(), i(n))]).unwrap();
    }

    let all = col.find(Filter::All).unwrap();
    assert_eq!(all.len(), 20);

    let filtered = col.find(Filter::Gte("n".into(), i(10))).unwrap();
    assert_eq!(filtered.len(), 10);
}
