---
title: Encryption at Rest
description: Enable AES-GCM-256 encryption by passing a passphrase to openDB. No extra setup required.
---

# Encryption at Rest

TalaDB supports transparent AES-GCM-256 encryption. Every document stored on disk is encrypted — just pass a `passphrase` option when opening the database.

## Enabling encryption

```ts
import { openDB } from 'taladb';

const db = await openDB('myapp.db', { passphrase: 'my-secret-password' });
```

That's it. All reads and writes behave exactly the same — encryption is completely transparent.

## How it works

- Your passphrase is never stored on disk
- A random salt is generated on first open and stored alongside the database — it is used to re-derive the key each time you open with the same passphrase
- Each stored value is encrypted with AES-GCM-256 using a unique random nonce
- If you open the database with the wrong passphrase, you'll get an error on the first read

## Wrong passphrase

If the passphrase is incorrect, TalaDB throws on the first read attempt:

```ts
try {
  const db = await openDB('myapp.db', { passphrase: 'wrong-password' });
  await db.collection('users').find(); // ← throws here
} catch (err) {
  console.error('Wrong passphrase or corrupted database.');
}
```

## Security tips

- **Never hard-code the passphrase.** Accept it from user input, the OS keychain, or a secrets manager.
- **Use a strong passphrase.** TalaDB uses PBKDF2-HMAC-SHA256 with 100,000 iterations to derive the encryption key, so a weak passphrase is the main risk.
- **Losing the passphrase means losing the data.** There is no recovery path — TalaDB does not store or escrow the key.

## What is encrypted

| Data | Encrypted |
|------|-----------|
| Document content | ✅ Yes |
| Document IDs | No |
| Index entries | No |

Document content (all your fields and values) is fully encrypted. Document IDs and index entries are not — this is the trade-off that allows range queries and index scans to work without decrypting every record first.
