---
title: Encryption at Rest
description: Enable transparent AES-GCM-256 encryption at rest on Node.js, the browser (WASM + OPFS), and React Native.
---

# Encryption at Rest

TalaDB supports transparent AES-GCM-256 encryption on **all three runtimes** — Node.js, the browser (WASM + OPFS), and native React Native.

## Enabling encryption

On **Node.js and the browser**, pass a `passphrase` to `openDB`:

```ts
import { openDB } from 'taladb';

const db = await openDB('myapp.db', { passphrase: 'my-secret-password' });
```

In **React Native**, encryption is selected while installing the native JSI database (the passphrase goes in the config JSON, since the native handle is opened at `initialize` time):

```ts
await TalaDBModule.initialize('myapp.db', JSON.stringify({
  passphrase: userSuppliedPassphrase,
}))
const db = await openDB('myapp.db')
```

All reads and writes behave the same after opening. Keep the generated salt sidecar together with the database; losing either the passphrase or salt makes the data unrecoverable. (On Node.js/RN this is a `*.taladb-salt` file; in the browser it is a companion file in the same OPFS directory as the database.)

::: warning Browser encryption requires OPFS and is single-tab
Encryption in the browser depends on OPFS (available in all current browsers). If OPFS is unavailable, `openDB({ passphrase })` **fails closed** rather than falling back to the plaintext in-memory/IndexedDB path. Encrypted browser databases are also **single-tab**: the multi-tab fallback works by sharing a decrypted snapshot through IndexedDB, which would defeat encryption, so a second tab opening the same encrypted database is refused. Unencrypted databases keep full multi-tab support.
:::

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
