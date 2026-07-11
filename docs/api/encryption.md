---
title: Encryption at Rest
description: Enable AES-GCM-256 encryption for native TalaDB databases.
---

# Encryption at Rest

TalaDB supports transparent AES-GCM-256 encryption for Node.js and the native React Native engine. Browser encryption is not yet available; passing `passphrase` in a browser fails closed instead of opening plaintext storage.

## Enabling encryption

```ts
import { openDB } from 'taladb';

const db = await openDB('myapp.db', { passphrase: 'my-secret-password' });
```

The `openDB` option above applies to Node.js. In React Native, encryption must be selected while installing the native JSI database:

```ts
await TalaDBModule.initialize('myapp.db', JSON.stringify({
  passphrase: userSuppliedPassphrase,
}))
const db = await openDB('myapp.db')
```

All reads and writes behave the same after opening. Keep the generated `*.taladb-salt` sidecar together with the database; losing either the passphrase or salt makes the data unrecoverable.

Encryption must be selected when creating a database. Passing a passphrase for an existing plaintext database fails rather than silently mixing plaintext and ciphertext; export/import into a newly encrypted database to migrate existing data.

## How it works

- Your passphrase is never stored on disk
- A random salt is generated on first open and stored in a restricted-permission sidecar file
- Each stored value is encrypted with AES-GCM-256 using a unique random nonce
- Opening with the wrong passphrase fails before a database handle is returned

## Wrong passphrase

If the passphrase is incorrect, TalaDB rejects the open operation:

```ts
try {
  await openDB('myapp.db', { passphrase: 'wrong-password' }); // throws
} catch (err) {
  console.error('Wrong passphrase or corrupted database.');
}
```

## Security tips

- **Never hard-code the passphrase.** Accept it from user input, the OS keychain, or a secrets manager.
- **Use a strong passphrase.** TalaDB uses PBKDF2-HMAC-SHA256 with 600,000 iterations to derive the encryption key, so a weak passphrase remains the main risk.
- **Losing the passphrase means losing the data.** There is no recovery path — TalaDB does not store or escrow the key.

## What is encrypted

| Data | Encrypted |
|------|-----------|
| Document content | ✅ Yes |
| Document IDs | No |
| Index keys | No |

Document content (all your fields and values) is fully encrypted. Document IDs and index entries are not — this is the trade-off that allows range queries and index scans to work without decrypting every record first.
