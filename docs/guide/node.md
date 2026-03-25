# Node.js

TalaDB's Node.js integration uses a prebuilt native `.node` module produced by [napi-rs](https://napi.rs). The Rust engine runs natively — no WASM, no subprocess — so performance is identical to embedding the Rust library directly.

## How it works

```
Your Node.js process
        │  N-API (native ABI)
        ▼
taladb-node (.node native module)
        │
        ▼
taladb-core (Rust) + redb (file on disk)
```

Because the native module links directly into the Node.js process, reads and writes are synchronous at the Rust level. The JavaScript API wraps them in `Promise`s for consistency with the browser adapter, but there is no async overhead beyond V8's microtask scheduling.

## Prerequisites

- Node.js 18 or later
- A supported OS / architecture:
  - `linux-x64-gnu`
  - `linux-arm64-gnu`
  - `darwin-x64`
  - `darwin-arm64` (Apple Silicon)
  - `win32-x64-msvc`

## Installation

```bash
npm install taladb taladb-node
# or
pnpm add taladb taladb-node
```

The `taladb-node` package ships platform-specific prebuilt binaries. When you install the package, `@napi-rs/cli` selects the correct `.node` file for your platform.

## Opening a database

```ts
import { openDB } from 'taladb'

// Opens (or creates) a redb database file at the given path
const db = await openDB('./data/myapp.db')
```

The database file is created if it does not exist. Parent directories must exist. The `.db` extension is conventional but not required.

### In-memory database

For testing or ephemeral use:

```ts
import { TalaDBNode } from 'taladb-node'

const db = TalaDBNode.openInMemory()
```

An in-memory database is not persisted to disk and is discarded when the process exits.

## TypeScript setup

```ts
// tsconfig.json — recommended settings
{
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "target": "ES2022",
    "strict": true
  }
}
```

## Basic CRUD

```ts
import { openDB } from 'taladb'

interface Task {
  _id?: string
  title: string
  done: boolean
  priority: 1 | 2 | 3
  createdAt: number
}

const db = await openDB('./tasks.db')
const tasks = db.collection<Task>('tasks')

// Indexes — create once at startup (idempotent)
await tasks.createIndex('done')
await tasks.createIndex('priority')

// Insert
const id = await tasks.insert({
  title: 'Write documentation',
  done: false,
  priority: 1,
  createdAt: Date.now(),
})

// Find all undone tasks with priority 1
const urgent = await tasks.find({
  $and: [{ done: false }, { priority: 1 }],
})

// Find one by ID
const task = await tasks.findOne({ _id: id })

// Mark done
await tasks.updateOne({ _id: id }, { $set: { done: true } })

// Delete completed tasks
const removed = await tasks.deleteMany({ done: true })
```

## Using the low-level native API directly

If you need synchronous access or want to avoid the `taladb` wrapper, import `taladb-node` directly:

```ts
import { TalaDBNode } from 'taladb-node'

const db = TalaDBNode.open('./myapp.db')
const col = db.collection('users')

// Synchronous at the Rust level — Promise resolves in the same microtask
col.createIndex('email')
const id = col.insert({ name: 'Alice', email: 'alice@example.com' })
const alice = col.findOne({ email: 'alice@example.com' })

db.close()
```

## Server usage example

```ts
// server.ts — Express + TalaDB
import express from 'express'
import { openDB } from 'taladb'

interface Event {
  _id?: string
  type: string
  payload: Record<string, unknown>
  ts: number
}

const app = express()
app.use(express.json())

const db = await openDB('./events.db')
const events = db.collection<Event>('events')
await events.createIndex('type')
await events.createIndex('ts')

app.post('/events', async (req, res) => {
  const id = await events.insert({
    type: req.body.type,
    payload: req.body.payload ?? {},
    ts: Date.now(),
  })
  res.json({ id })
})

app.get('/events', async (req, res) => {
  const { type, since } = req.query
  const filter: object = {}
  if (type) Object.assign(filter, { type })
  if (since) Object.assign(filter, { ts: { $gte: Number(since) } })
  const docs = await events.find(filter)
  res.json(docs)
})

app.listen(3000)
```

## Migrations

```ts
const db = await openDB('./myapp.db', {
  migrations: [
    {
      version: 1,
      description: 'Index users by email',
      up: async (db) => {
        await db.collection('users').createIndex('email')
      },
    },
  ],
})
```

Migrations run at open time, in version order, inside a single atomic transaction.

## Snapshot export / import

```ts
import fs from 'node:fs/promises'

// Export
const bytes = await db.exportSnapshot()
await fs.writeFile('backup.taladb', bytes)

// Restore
const data = await fs.readFile('backup.taladb')
const restored = await Database.restoreFromSnapshot(data)
```

## Closing

```ts
await db.close()
```

Always close the database before the process exits to flush any pending writes and release the file lock.

## Testing with an in-memory database

```ts
// vitest / jest
import { TalaDBNode } from 'taladb-node'

beforeEach(() => {
  db = TalaDBNode.openInMemory()
})

afterEach(() => {
  db.close()
})
```

Using an in-memory database in tests means no file system cleanup and no interference between test runs.

## CLI

The `taladb-cli` binary is built alongside `taladb-node` and can inspect any redb database file produced by TalaDB:

```bash
cargo install --path packages/taladb-cli

taladb inspect ./myapp.db
taladb export  ./myapp.db
taladb count   ./myapp.db users
taladb drop    ./myapp.db sessions
```
