# Features

## Document model with ULID IDs

Documents are schemaless key-value maps. Every document is automatically assigned a [ULID](https://github.com/ulid/spec) — a 128-bit, time-sortable, lexicographically ordered identifier. ULIDs are safe for URLs, monotonically increasing within the same millisecond, and require no coordination between writers.

## MongoDB-like query API

TalaDB exposes a filter and update DSL that mirrors the MongoDB query language:

- **Comparison:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`
- **Membership:** `$in`, `$nin`
- **Logical:** `$and`, `$or`, `$not`
- **Existence:** `$exists`
- **Update operators:** `$set`, `$unset`, `$inc`, `$push`, `$pull`

The full API is fully typed — TypeScript narrows filter and update shapes to the document type passed to `db.collection<T>()`.

## Secondary indexes with automatic index selection

Indexes are created per field with `createIndex('fieldName')`. The underlying storage is a redb B-tree keyed by `[type_prefix][encoded_value][ulid]`. This layout gives:

- **O(log n) point lookups** via `$eq` or `$in`
- **O(log n + k) range scans** via `$gt`, `$gte`, `$lt`, `$lte`
- **Correct cross-type ordering** — integers, floats, strings, and booleans each carry a type prefix so they never collide in the same index

The query planner examines the filter and picks the most selective available index automatically. No hints or query annotations are needed.

## ACID transactions via redb

Every write is wrapped in an ACID transaction at the storage layer. Document writes and index updates happen atomically — there is no window where a document exists but its index entry is missing, or vice versa. On crash or power loss, redb recovers to the last committed state.

## Full-text search

`createIndex` supports a special `_fts:{field}` syntax that builds an inverted token index for a string field. The `$contains` filter operator matches documents whose field value contains all of the supplied search terms after normalisation (lowercasing, punctuation removal, short-word filtering).

```ts
await posts.createIndex('_fts:body')
const results = await posts.find({ body: { $contains: 'rust embedded database' } })
```

## Live queries

`collection.watch(filter)` returns a `WatchHandle`. Calling `next()` blocks until the next write to the collection, then re-runs the filter and returns the current matching documents. Multiple handles can watch the same collection with different filters simultaneously, with no per-watch overhead beyond an MPSC channel.

## Schema migrations

`openDB` accepts a `migrations` array. TalaDB stores the current version number inside the database and runs any pending `up` functions in order at startup, inside a single atomic transaction. Failed migrations roll back automatically.

## Encryption at rest

The `encryption` Cargo feature adds:

- `EncryptedBackend` — a `StorageBackend` wrapper that encrypts every value with AES-GCM-256 before writing and decrypts on read
- `encrypt` / `decrypt` — low-level primitives for manual use
- `derive_key` — PBKDF2-HMAC-SHA256 key derivation from a passphrase and salt

Nonces are generated per write using the OS random number generator. The 16-byte GCM authentication tag prevents silent data corruption and detects tampering.

## OPFS-backed browser persistence

In the browser, TalaDB runs inside a SharedWorker and uses `FileSystemSyncAccessHandle` from the Origin Private File System (OPFS) API for durable, origin-isolated storage. Multiple tabs share the same SharedWorker instance, which serialises all writes and prevents corruption.

On browsers without SharedWorker support (primarily iOS Safari before 16.4), TalaDB falls back to an in-memory WASM instance so the application continues to work, with data lost on reload.

## Platform-detecting unified package

The `taladb` npm package auto-detects the runtime at import time:

- Presence of `globalThis.nativeCallSyncHook` → React Native JSI
- Presence of `globalThis.window` + `navigator` → browser WASM
- Otherwise → Node.js native module

Application code never branches on platform. Swap the runtime and the same TypeScript continues to work.

## TypeScript generics

```ts
interface Product {
  _id?: string
  name: string
  price: number
  inStock: boolean
}

const products = db.collection<Product>('products')

// Filter<Product> — TypeScript validates field names and value types
await products.find({ price: { $lte: 99.99 }, inStock: true })

// Update<Product> — $set only accepts fields that exist on Product
await products.updateOne({ name: 'Widget' }, { $set: { price: 49.99 } })
```

## CLI dev tools

The `taladb-cli` binary ships with the workspace for local development and debugging:

```bash
taladb inspect myapp.db          # show collections, document counts, index names
taladb export myapp.db           # dump all documents as JSON
taladb import myapp.db data.json # bulk-import from JSON
taladb count myapp.db users      # count documents in a collection
taladb drop myapp.db sessions    # drop a collection
```

## Snapshot export / import

```ts
// Export the entire database to a portable binary snapshot
const bytes = await db.exportSnapshot()

// Restore on another device or after clearing storage
const db2 = await Database.restoreFromSnapshot(bytes)
```

Snapshots use a compact binary format (`TDBS` magic + version + length-prefixed KV pairs) and include every table — documents and indexes — so the restored database is immediately queryable without re-indexing.
