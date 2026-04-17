---
title: Cloudflare Workers Guide
description: Run TalaDB inside Cloudflare Workers Durable Objects. In-memory WASM engine with automatic snapshot persistence between requests.
---

# Cloudflare Workers

`@taladb/cloudflare` brings TalaDB to [Cloudflare Workers](https://workers.cloudflare.com/) via [Durable Objects](https://developers.cloudflare.com/durable-objects/). The existing `@taladb/web` WASM core runs in-memory inside a Durable Object isolate. State is serialised to a binary snapshot and stored with `storage.put()` after each mutating request, then restored on cold start or hibernation wake-up.

## How it works

```
Request → Durable Object → TalaDB (in-memory WASM)
                                ↓
                    storage.put('__taladb_snapshot__', bytes)
                    (binary snapshot, restored on next cold start)
```

- **One DO instance = one TalaDB database.** Each Durable Object ID has its own isolated database.
- **No OPFS.** Workers don't have filesystem access — state lives in memory during a request and is flushed to Durable Objects storage as a compact binary snapshot.
- **HNSW vector indexes are not supported** (requires native threads). Flat vector search works.
- **`subscribe()` is not supported** — use `find()` inside request handlers instead.

## Requirements

- Cloudflare Workers with Durable Objects enabled (paid plan)
- `@taladb/web` must be bundled with your Worker (it's a peer dependency)

## Installation

```bash
pnpm add @taladb/cloudflare @taladb/web taladb
```

## Quick start — base class

The simplest approach is to extend `TalaDBDurableObject` and override `fetch`:

```ts
// src/index.ts
import { TalaDBDurableObject } from '@taladb/cloudflare'

interface User {
  _id?: string
  name: string
  email: string
}

export class UserDB extends TalaDBDurableObject {
  async fetch(request: Request): Promise<Response> {
    const db = await this.getDB()
    const users = db.collection<User>('users')

    if (request.method === 'POST') {
      const body = await request.json<Omit<User, '_id'>>()
      const id = await users.insert(body)
      await db.flush()                    // persist snapshot to DO storage
      return Response.json({ id })
    }

    return Response.json(await users.find())
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.USER_DB.idFromName('default')
    return env.USER_DB.get(id).fetch(request)
  },
}

interface Env {
  USER_DB: DurableObjectNamespace
}
```

```toml
# wrangler.toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[durable_objects.bindings]]
name = "USER_DB"
class_name = "UserDB"

[[migrations]]
tag = "v1"
new_classes = ["UserDB"]
```

## Quick start — openDurableDB

For more control, use `openDurableDB` directly inside your Durable Object's `fetch` method:

```ts
import { openDurableDB } from '@taladb/cloudflare'

export class ProductDB {
  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const db = await openDurableDB(this.ctx.storage)
    const products = db.collection<Product>('products')

    switch (request.method) {
      case 'GET': {
        const url = new URL(request.url)
        const category = url.searchParams.get('category')
        const filter = category ? { category } : {}
        return Response.json(await products.find(filter))
      }
      case 'POST': {
        const body = await request.json<Product>()
        const id = await products.insert(body)
        await db.flush()
        return Response.json({ id }, { status: 201 })
      }
      default:
        return new Response('Method Not Allowed', { status: 405 })
    }
  }
}
```

## `db.flush()`

Call `flush()` after any request that mutates data. It serialises the in-memory database to a binary snapshot and stores it via `storage.put()`. Without a `flush()`, changes are lost when the isolate hibernates.

```ts
await users.insert({ name: 'Alice' })
await db.flush()  // always flush after mutations
```

For read-only requests you can skip `flush()`:

```ts
const all = await users.find()          // read-only — no flush needed
return Response.json(all)
```

## `db.compact()`

After bulk deletes, call `compact()` before `flush()` to reduce the snapshot size stored in Durable Objects:

```ts
await users.deleteMany({ archived: true })
await db.compact()   // shrink in-memory redb before serialising
await db.flush()
```

Note: `compact()` on an in-memory backend is effectively a no-op for size — the real savings come from deleting documents before the snapshot is exported.

## Multiple Durable Object instances

Each DO instance is a separate TalaDB database. Route users to different instances to shard your data:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const tenantId = url.searchParams.get('tenant') ?? 'default'

    // Each tenant gets their own isolated database
    const id = env.TENANT_DB.idFromName(tenantId)
    return env.TENANT_DB.get(id).fetch(request)
  },
}
```

## Indexes

Indexes are stored as part of the snapshot and persist across cold starts:

```ts
async fetch(request: Request): Promise<Response> {
  const db = await this.getDB()
  const products = db.collection<Product>('products')

  // Create indexes on first request — idempotent, safe to call every time
  await products.createIndex('category')
  await products.createFtsIndex('description')

  // ...
}
```

For performance-sensitive Workers, create indexes once during a separate initialisation request rather than on every fetch.

## Vector search

Flat (brute-force) vector search works in Cloudflare Workers. HNSW (approximate nearest-neighbour) is not available because it requires native threads.

```ts
const docs = db.collection<Doc>('docs')
await docs.createVectorIndex('embedding', { dimensions: 1536, metric: 'cosine' })

await docs.insert({ text: 'hello world', embedding: await embed('hello world') })
await db.flush()

const results = await docs.findNearest('embedding', await embed('find me'), 5)
```

Attempting to create an HNSW index throws immediately:

```ts
// ✗ throws: "HNSW vector indexes are not available in Cloudflare Workers"
await docs.createVectorIndex('embedding', { dimensions: 1536, indexType: 'hnsw' })
```

## Full CRUD example

```ts
import { TalaDBDurableObject } from '@taladb/cloudflare'

interface Note {
  _id?: string
  title: string
  body: string
  tags: string[]
  createdAt: number
}

export class NoteDB extends TalaDBDurableObject {
  async fetch(request: Request): Promise<Response> {
    const db = await this.getDB()
    const notes = db.collection<Note>('notes')
    const url = new URL(request.url)

    // GET /notes?tag=work
    if (request.method === 'GET') {
      const tag = url.searchParams.get('tag')
      const filter = tag ? { tags: { $in: [tag] } } : {}
      return Response.json(await notes.find(filter))
    }

    // POST /notes
    if (request.method === 'POST') {
      const body = await request.json<Omit<Note, '_id' | 'createdAt'>>()
      const id = await notes.insert({ ...body, createdAt: Date.now() })
      await db.flush()
      return Response.json({ id }, { status: 201 })
    }

    // PATCH /notes/:id
    if (request.method === 'PATCH') {
      const id = url.pathname.split('/').at(-1)!
      const patch = await request.json<Partial<Note>>()
      const updated = await notes.updateOne({ _id: id }, { $set: patch })
      if (!updated) return new Response('Not Found', { status: 404 })
      await db.flush()
      return new Response(null, { status: 204 })
    }

    // DELETE /notes/:id
    if (request.method === 'DELETE') {
      const id = url.pathname.split('/').at(-1)!
      const deleted = await notes.deleteOne({ _id: id })
      if (!deleted) return new Response('Not Found', { status: 404 })
      await db.flush()
      return new Response(null, { status: 204 })
    }

    return new Response('Method Not Allowed', { status: 405 })
  }
}
```

## Snapshot size

The binary snapshot grows with data. Cloudflare Durable Objects `storage.put()` has a per-value size limit of **128 KiB** by default (up to 2 MiB with the `storage.put` options). For larger datasets, consider sharding across multiple DO instances (one per user, one per tenant, etc.).

## Limitations

| Feature | Status |
|---|---|
| OPFS persistence | Not available — Workers have no filesystem |
| HNSW vector index | Not available — requires native threads |
| `subscribe()` / live queries | Not available — use `find()` in request handlers |
| File-backed database (`openDB('./file.db')`) | Not available |
| Atomic cross-request transactions | Not available — each request gets its own in-memory snapshot |
