---
title: Web Guide — Browser / WASM
description: Use TalaDB in the browser with WebAssembly and OPFS persistent storage. Works with Vite, Next.js, and any modern bundler.
---

# Web (Browser / WASM)

TalaDB runs in the browser as a WebAssembly module compiled from the same Rust core used on every other platform. Data is persisted to the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) (OPFS) — a fast, private storage area built into modern browsers. No server, no cloud, no extra infrastructure.

## Browser support

| Feature | Chrome | Firefox | Safari |
|---|---|---|---|
| WASM (in-memory) | 79+ | 78+ | 14+ |
| OPFS (fastest persistence) | 86+ | 111+ | 15.2+ |
| IndexedDB fallback (persistence without OPFS) | 79+ | 78+ | 14+ |

On browsers without OPFS, TalaDB automatically falls back to an IndexedDB-backed database. Data still persists across page reloads — writes are a bit slower because each one flushes a snapshot to IndexedDB.

## Installation

```bash
pnpm add taladb @taladb/web
```

## Vite setup

Add two things to `vite.config.ts`:
1. Exclude `taladb` and `@taladb/web` from dependency pre-bundling
2. Set the COOP/COEP headers required for OPFS in a Worker context

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['taladb', '@taladb/web'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
})
```

## Quick start

```ts
import { openDB } from 'taladb'

const db = await openDB('myapp.db')
const users = db.collection('users')

await users.insert({ name: 'Alice', age: 30 })
const all = await users.find()
```

That's all the setup you need. `openDB` detects the browser automatically, opens a persistent OPFS database named `myapp.db`, and returns a collection API identical to Node.js and React Native.

## HTTP push sync

Pass a `config` option to `openDB` to push mutation events to a remote endpoint after every write:

```ts
import { openDB } from 'taladb'

const db = await openDB('myapp.db', {
  config: {
    sync: {
      enabled: true,
      endpoint: 'https://api.example.com/taladb-events',
      headers: { Authorization: `Bearer ${myToken}` },
      exclude_fields: ['embedding'],  // omit large vector fields
    },
  },
})

// Every write now fires an HTTP event in the background
const users = db.collection('users')
await users.insert({ name: 'Alice', role: 'admin' })
```

After every committed write, TalaDB fires a background `fetch` on the JS microtask queue and POSTs the event payload to the configured endpoint with up to **3 retries** and exponential backoff (200 ms / 400 ms / 800 ms). Writes are never blocked.

::: warning Tab lifetime
In-flight sync requests are subject to normal browser fetch constraints. If the user closes the tab during a retry sequence, any remaining attempts are lost. Sync is best-effort by design.
:::

Per-event endpoint overrides are supported:

```ts
const db = await openDB('myapp.db', {
  config: {
    sync: {
      enabled: true,
      endpoint: 'https://api.example.com/events',
      insert_endpoint: 'https://api.example.com/events/insert',
      update_endpoint: 'https://api.example.com/events/update',
      delete_endpoint: 'https://api.example.com/events/delete',
      headers: { Authorization: 'Bearer YOUR_TOKEN' },
    },
  },
})
```

See the [HTTP Push Sync guide](/guide/http-sync) for the full config reference, payload shapes, and retry behaviour.

## Defining your schema

TalaDB is schemaless, but TypeScript generics let you describe the shape of each collection:

```ts
interface User {
  _id?: string
  name: string
  email: string
  age: number
  role: 'user' | 'admin'
  createdAt: number
}
```

## Basic CRUD

```ts
const users = db.collection<User>('users')

// Create indexes at startup — idempotent, safe to call on every open
await users.createIndex('email')
await users.createIndex('age')

// Insert — returns the generated ULID string
const id = await users.insert({
  name: 'Alice',
  email: 'alice@example.com',
  age: 30,
  role: 'user',
  createdAt: Date.now(),
})

// Insert many
await users.insertMany([
  { name: 'Bob',   email: 'bob@example.com',   age: 25, role: 'user',  createdAt: Date.now() },
  { name: 'Carol', email: 'carol@example.com', age: 35, role: 'admin', createdAt: Date.now() },
])

// Find all
const everyone = await users.find()

// Find with filter — uses index automatically
const adults = await users.find({ age: { $gte: 18 } })

// Find one
const alice = await users.findOne({ email: 'alice@example.com' })

// Count
const adminCount = await users.count({ role: 'admin' })

// Update
await users.updateOne({ email: 'alice@example.com' }, { $set: { age: 31 } })
await users.updateMany({ role: 'user' }, { $set: { verified: true } })

// Delete
await users.deleteOne({ email: 'alice@example.com' })
await users.deleteMany({ role: 'banned' })
```

## Queries

```ts
// Range
const thirties = await users.find({ age: { $gte: 30, $lte: 39 } })

// OR — uses IndexOr plan when both fields are indexed
const staff = await users.find({
  $or: [{ role: 'admin' }, { role: 'moderator' }],
})

// Membership test
const team = await users.find({ role: { $in: ['admin', 'moderator', 'editor'] } })

// Compound AND
const activeAdults = await users.find({
  $and: [{ age: { $gte: 18 } }, { role: { $ne: 'banned' } }],
})
```

## Full-text search

Create an FTS index on any string field to enable fast `$contains` queries without scanning every document:

```ts
const posts = db.collection<Post>('posts')

// Create once at startup — idempotent
await posts.createFtsIndex('body')

// Query — uses the FTS index automatically (O(1) token lookup)
const results = await posts.find({ body: { $contains: 'taladb' } })
```

## Inspecting indexes

```ts
const { btree, fts, vector } = await users.listIndexes()
// btree: ['email', 'age']
// fts:   []
// vector: []
```

## Live queries in React

`subscribe` fires the callback immediately with the current results, then again after any write that could affect the result set. Call the returned function to unsubscribe.

```tsx
import { useEffect, useState } from 'react'
import { openDB, type Collection, type Document } from 'taladb'

function useLiveQuery<T extends Document>(col: Collection<T>, filter = {}) {
  const [docs, setDocs] = useState<T[]>([])

  useEffect(() => {
    const unsub = col.subscribe(filter, setDocs)
    return unsub
  }, [])

  return docs
}

// Usage
const admins = useLiveQuery(db.collection<User>('users'), { role: 'admin' })
```

## Vector search

Store and search embeddings from an on-device model — no cloud API, no data leaving the browser.

```ts
import { pipeline } from '@huggingface/transformers'

// Model is downloaded and cached on first use (~25 MB for MiniLM)
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')

async function embed(text: string): Promise<number[]> {
  const out = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(out.data) as number[]
}
```

```ts
interface Article {
  _id?: string
  title: string
  body: string
  category: string
  embedding: number[]
}

const articles = db.collection<Article>('articles')

// Create once at startup — idempotent
await articles.createVectorIndex('embedding', { dimensions: 384 })

// Insert with embedding
await articles.insert({
  title: 'Getting started',
  body: '...',
  category: 'guide',
  embedding: await embed('Getting started'),
})

// Semantic search
const queryVec = await embed('how do I begin')
const results = await articles.findNearest('embedding', queryVec, 5)

results.forEach(({ document, score }) => {
  console.log(`${score.toFixed(3)}  ${document.title}`)
})

// Hybrid: filter first, then rank by similarity — one call, no extra round-trips
const filtered = await articles.findNearest('embedding', queryVec, 5, {
  category: 'guide',
})
```

### Similarity metrics

| Metric | Best for | Score range |
|---|---|---|
| `cosine` (default) | Text embeddings, normalised vectors | [-1, 1] |
| `dot` | Embeddings where magnitude matters | Unbounded |
| `euclidean` | Spatial / coordinate data | (0, 1] |

## Migrations

Run schema changes at open time — each migration runs once, in order, atomically:

```ts
const db = await openDB('myapp.db', {
  migrations: [
    {
      version: 1,
      description: 'Add email index',
      up: async (db) => {
        await db.collection('users').createIndex('email')
      },
    },
    {
      version: 2,
      description: 'Backfill role field',
      up: async (db) => {
        const users = db.collection('users')
        for (const user of await users.find({})) {
          if (!user.role) {
            await users.updateOne({ _id: user._id }, { $set: { role: 'user' } })
          }
        }
      },
    },
  ],
})
```

## Exporting a snapshot

```ts
// Export the whole database to a Uint8Array
const bytes = await db.exportSnapshot()

// Save as a file download
const blob = new Blob([bytes], { type: 'application/octet-stream' })
const url  = URL.createObjectURL(blob)
const a    = Object.assign(document.createElement('a'), { href: url, download: 'myapp.taladb' })
a.click()
```

## Closing the database

```ts
await db.close()
```

## Current limitations

- **HNSW vector index** — not available in the browser. The HNSW algorithm uses `rayon` for parallelism which requires native threads. Calling `createVectorIndex({ indexType: 'hnsw' })` or `upgradeVectorIndex()` in the browser throws a clear error. Flat (brute-force) vector search works fine for collections up to ~100k vectors.
- **Multi-tab writes** — only the first tab to open the database holds the exclusive OPFS file lock (via the Web Locks API). Additional tabs fall back to an IndexedDB-backed in-memory copy that stays fresh as the primary tab writes. Writes from secondary tabs are local only — they are not synced back to the primary tab or to OPFS.
