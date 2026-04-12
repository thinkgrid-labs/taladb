---
title: Features
description: Vector similarity search, ULID document IDs, MongoDB-like queries, secondary B-tree indexes, ACID transactions, full-text search, live queries, AES-GCM-256 encryption, OPFS persistence, and more.
---

# Features

## Vector index and similarity search

TalaDB v0.2 introduces on-device vector indexes — the first embedded JavaScript database to natively combine document queries with vector similarity search.

### Creating a vector index

```ts
// Register a vector index on any numeric-array field
await articles.createVectorIndex('embedding', { dimensions: 384 })

// Choose a metric (default: cosine)
await articles.createVectorIndex('embedding', {
  dimensions: 1536,
  metric: 'cosine', // | 'dot' | 'euclidean'
})
```

Existing documents are backfilled automatically. New inserts and updates maintain the index atomically alongside the document write.

### Pure vector search

```ts
const queryVec = await embed('how do I reset my password?') // your on-device model

const results = await articles.findNearest('embedding', queryVec, 5)
// [{ document: Article, score: 0.94 }, { document: Article, score: 0.91 }, ...]
```

Results are ordered by descending similarity score. Score range depends on the metric:
- `cosine` — [-1, 1], identical vectors score 1.0
- `dot` — unbounded, depends on vector magnitude
- `euclidean` — (0, 1], identical vectors score 1.0

### Hybrid search — metadata filter + vector ranking

The killer feature. Pass a regular document filter as the fourth argument to restrict the candidate set before ranking:

```ts
// Find the 5 most semantically similar english-language support articles
const results = await articles.findNearest('embedding', queryVec, 5, {
  locale: 'en',
  category: 'support',
  published: true,
})
```

This is the pattern cloud vector databases (Qdrant, Weaviate, Pinecone) charge for — running entirely on device, with no network latency and no data leaving the user's device.

### Dropping a vector index

```ts
await articles.dropVectorIndex('embedding')
```

### Pairing with on-device AI

TalaDB vector indexes are designed to work alongside client-side embedding models:

```ts
import { pipeline } from '@xenova/transformers'

const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')

async function embed(text: string): Promise<number[]> {
  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

// Insert a document with its embedding
const vec = await embed(article.body)
await articles.insert({ ...article, embedding: vec })

// Search later
const results = await articles.findNearest('embedding', await embed(query), 5)
```

No cloud API key. No rate limit. No round-trip.

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

## HTTP push sync

After every committed write, TalaDB fires a background HTTP POST to a configured endpoint — no infrastructure required on TalaDB's side. Works with any existing REST API, webhook receiver, or analytics pipeline.

```yaml
# taladb.config.yml
sync:
  enabled: true
  endpoint: "https://api.example.com/events"
  headers:
    Authorization: "Bearer my-token"
  exclude_fields:
    - embedding   # strip large vectors from the payload
```

The background thread is completely detached from the write path. **No transaction is ever delayed or blocked by sync.** Payload shapes:

- **insert** — `{ _taladb_event, collection, id, document, timestamp }`
- **update** — `{ _taladb_event, collection, id, changes, timestamp }` (delta only — changed fields)
- **delete** — `{ _taladb_event, collection, id, timestamp }`

Retries up to 3 times with 200 / 400 / 800 ms backoff on 5xx or network errors. The `taladb sync` CLI command pushes the full local state for initial seeding or recovery.

See the [HTTP Push Sync guide](/guide/http-sync) for full documentation.

## CLI dev tools

Download the pre-built `taladb-cli` binary for your platform from the [GitHub Releases page](https://github.com/thinkgrid-labs/taladb/releases):

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
