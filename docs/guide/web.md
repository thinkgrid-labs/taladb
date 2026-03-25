---
title: Web Guide — Browser / WASM
description: Use TalaDB in the browser with WebAssembly and OPFS persistent storage via a SharedWorker. Works with Vite, Next.js, and any modern bundler.
---

# Web (Browser / WASM)

TalaDB runs in the browser as a WebAssembly module compiled from the same Rust core used on every other platform. Persistent storage is provided by the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) (OPFS) via a SharedWorker.

## How it works

```
Your React app
     │  postMessage
     ▼
SharedWorker (taladb.worker.js)
     │  FileSystemSyncAccessHandle (OPFS)
     ▼
@taladb/web (Rust + redb, compiled to WASM)
```

The SharedWorker owns the OPFS file handle and the WASM instance. All tabs in the same origin share the same worker, so there is always exactly one writer — no write conflicts between tabs.

On browsers without SharedWorker (primarily iOS Safari before 16.4) the library falls back to an in-memory WASM instance automatically. Data written in the fallback mode is not persisted across page reloads.

## Prerequisites

- Chrome 86+, Edge 86+, Firefox 111+, or Safari 16.4+ (persistent storage)
- A bundler that supports `new URL(specifier, import.meta.url)` — Vite, Rollup, Webpack 5, or esbuild

## Installation

```bash
npm install taladb @taladb/web
# or
pnpm add taladb @taladb/web
```

::: warning Build step required
`@taladb/web` ships prebuilt WASM artifacts. Run `wasm-pack build` inside `packages/@taladb/web` during your CI pipeline or before local development.
:::

## Vite setup

No Vite plugin is needed. The `new URL(...)` import in the library is handled natively by Vite's bundler.

Add the following to your `vite.config.ts` to allow SharedWorker:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // SharedWorker assets are automatically included when new URL() is used
  optimizeDeps: {
    exclude: ['@taladb/web'],
  },
})
```

## Opening a database

```ts
import { openDB } from 'taladb'

const db = await openDB('myapp.db')
```

`openDB` automatically detects that it is running in a browser, spins up (or connects to an existing) SharedWorker, and opens or creates the OPFS file named `myapp.db` within your origin's private storage directory.

### Opening with a snapshot

If you have a snapshot from a previous session or from another device, pass it to `openDB`:

```ts
const snapshot = loadSnapshotFromSomewhere()  // Uint8Array
const db = await openDB('myapp.db', { snapshot })
```

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

interface Post {
  _id?: string
  title: string
  body: string
  authorId: string
  publishedAt?: number
  tags: string[]
}
```

## Basic CRUD

```ts
const users = db.collection<User>('users')

// Create indexes at startup (idempotent)
await users.createIndex('email')
await users.createIndex('age')

// Insert one document — returns the generated ULID string
const id = await users.insert({
  name: 'Alice',
  email: 'alice@example.com',
  age: 30,
  role: 'user',
  createdAt: Date.now(),
})

// Insert many
const ids = await users.insertMany([
  { name: 'Bob',   email: 'bob@example.com',   age: 25, role: 'user',  createdAt: Date.now() },
  { name: 'Carol', email: 'carol@example.com', age: 35, role: 'admin', createdAt: Date.now() },
])

// Find all
const everyone = await users.find()

// Find with filter — uses the age index automatically
const adults = await users.find({ age: { $gte: 18 } })

// Find one
const alice = await users.findOne({ email: 'alice@example.com' })

// Count
const adminCount = await users.count({ role: 'admin' })

// Update one
await users.updateOne(
  { email: 'alice@example.com' },
  { $set: { age: 31 }, $inc: { loginCount: 1 } },
)

// Update many
const updated = await users.updateMany(
  { role: 'user' },
  { $set: { verified: true } },
)

// Delete one
const deleted = await users.deleteOne({ email: 'alice@example.com' })

// Delete many
const count = await users.deleteMany({ role: 'banned' })
```

## Range and complex queries

```ts
// Range on indexed field
const thirties = await users.find({ age: { $gte: 30, $lte: 39 } })

// OR across values — uses IndexOr plan when both fields are indexed
const adminsOrSuperusers = await users.find({
  $or: [{ role: 'admin' }, { role: 'superuser' }],
})

// Compound AND
const activeAdults = await users.find({
  $and: [
    { age: { $gte: 18 } },
    { role: { $ne: 'banned' } },
  ],
})

// Membership
const staff = await users.find({ role: { $in: ['admin', 'moderator', 'editor'] } })
```

## Migrations

Run schema changes at open time with the `migrations` option:

```ts
const db = await openDB('myapp.db', {
  migrations: [
    {
      version: 1,
      description: 'Create email index',
      up: async (db) => {
        await db.collection('users').createIndex('email')
      },
    },
    {
      version: 2,
      description: 'Add role field to existing users',
      up: async (db) => {
        const users = db.collection('users')
        const all = await users.find({})
        for (const user of all) {
          if (!user.role) {
            await users.updateOne({ _id: user._id }, { $set: { role: 'user' } })
          }
        }
      },
    },
  ],
})
```

## Live queries in React

```tsx
import { useEffect, useState } from 'react'
import { openDB, type Collection } from 'taladb'

function useWatch<T extends { _id?: string }>(
  col: Collection<T>,
  filter: object = {},
) {
  const [docs, setDocs] = useState<T[]>([])

  useEffect(() => {
    const handle = col.watch(filter)
    let cancelled = false

    async function poll() {
      while (!cancelled) {
        const snapshot = await handle.next()
        if (!cancelled) setDocs(snapshot)
      }
    }

    poll()
    return () => { cancelled = true }
  }, [])

  return docs
}

// Usage
const admins = useWatch(db.collection<User>('users'), { role: 'admin' })
```

## Exporting a snapshot

```ts
// Export the whole database to a Uint8Array
const bytes = await db.exportSnapshot()

// Save to local file
const blob = new Blob([bytes], { type: 'application/octet-stream' })
const url  = URL.createObjectURL(blob)
const a    = document.createElement('a')
a.href = url
a.download = 'myapp.taladb'
a.click()
```

## Closing the database

```ts
await db.close()
```

This sends a `close` message to the SharedWorker, which flushes any pending writes and releases the OPFS file handle.

## Browser compatibility table

| Feature | Chrome | Firefox | Safari |
|---|---|---|---|
| WASM (in-memory) | 79+ | 78+ | 14+ |
| OPFS (persistent) | 86+ | 111+ | 15.2+ |
| SharedWorker | 4+ | 29+ | 16+ |
| Full persistence | 86+ | 111+ | 16.4+ |
