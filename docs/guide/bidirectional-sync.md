---
title: Bidirectional Sync
description: Sync a local-first app (React, Next.js, React Native) to your backend — pull remote changes, push local changes, with Last-Write-Wins conflict resolution and incremental cursors. Includes server-to-server sync and a reference server.
---

# Bidirectional Sync

[HTTP Push Sync](/guide/http-sync) is fire-and-forget: it POSTs every local write outward and never hears back. **Bidirectional sync** is the full loop — pull remote changes into the local database *and* push local changes out, tracked by cursors so each pass is incremental, with automatic Last-Write-Wins conflict resolution.

::: info Runtime support
Available on **Node.js** and the **browser** (since v0.8.5 — both the OPFS worker and the in-memory fallback). In the browser, all sync engine work runs inside the Dedicated Worker, off the main thread, so a pass never blocks rendering. React Native shares the same engine; its binding wiring lands in a future release — calling `db.sync()` there throws a clear error until then. Track it on the [roadmap](/roadmap).
:::

## Client → server: sync your app to your backend

This is the flagship use case: **your app reads and writes purely locally** — every `find`, `insert`, and `subscribe` hits the on-device engine, works offline, and costs no network round-trip. Sync is a separate, periodic reconciliation with your backend, never part of the write path.

```
React / Next.js / RN app          your backend
┌──────────────────────┐   HTTPS   ┌──────────────────┐
│  TalaDB (on-device)  │◀────────▶│  POST /sync/push  │──▶ your database
│  reads/writes local  │  + token  │  GET  /sync/pull  │    (any store)
└──────────────────────┘           └──────────────────┘
        no secrets                 your security boundary
```

The client holds **no database credential** — it talks to *your* API with a user auth token, and your API owns storage and authorization. One `db.sync()` call per pass:

```ts
import { openDB, HttpSyncAdapter } from 'taladb'

const db = await openDB('myapp.db')

const adapter = new HttpSyncAdapter({
  endpoint: 'https://api.myapp.com/sync',            // POST {endpoint}/push · GET {endpoint}/pull?since=
  headers: { Authorization: `Bearer ${userToken}` }, // your API authenticates the user
})

const { pushed, pulled } = await db.sync(adapter, {})
```

Two devices editing offline both keep working; their next passes exchange the deltas, and if both edited the *same* document the newer `changed_at` wins on every device (see [How it works](#how-it-works)).

### React (browser SPA)

**Required:** `taladb` + `@taladb/web` (see the [Web guide](/guide/web) for the one-time Vite setup). **Optional:** `@taladb/react` for live-query hooks — synced changes appear in your components automatically, because `importChanges` fires the same notifications as local writes.

```bash
pnpm add taladb @taladb/web        # required
pnpm add @taladb/react             # optional: useFind / useFindOne hooks
```

```ts
// src/lib/db.ts — one database + one sync loop for the whole app
import { openDB, HttpSyncAdapter } from 'taladb'

export const dbPromise = openDB('myapp.db')

const adapter = new HttpSyncAdapter({
  endpoint: `${import.meta.env.VITE_API_URL}/sync`,
  headers: { Authorization: `Bearer ${getToken()}` },
})

export async function syncNow(): Promise<void> {
  const db = await dbPromise
  // Failed passes (offline, server down) are safe: cursors only advance on
  // success, and imports are idempotent — the next pass covers the gap.
  await db.sync(adapter, {}).catch((e) => console.warn('sync skipped:', e))
}
```

```tsx
// src/App.tsx — sync on start, on reconnect, on tab focus, and periodically
import { useEffect } from 'react'
import { syncNow } from './lib/db'

export function SyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    syncNow()                                              // app start
    const tick = setInterval(syncNow, 30_000)              // while open
    const onVisible = () => document.visibilityState === 'visible' && syncNow()
    window.addEventListener('online', syncNow)             // reconnect
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(tick)
      window.removeEventListener('online', syncNow)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return children
}
```

The whole pass — change export, LWW merge — executes inside TalaDB's worker, so even a large first sync never janks the UI; the main thread only awaits `postMessage`.

### Next.js

Same packages as React, plus the first-party integration (v0.8.5) that reduces both sides to a few lines:

```bash
pnpm add taladb @taladb/web @taladb/react @taladb/next
```

```ts
// app/api/sync/[[...action]]/route.ts — your complete sync backend
import { openDB } from 'taladb'
import { createSyncHandlers, taladbSyncStore } from '@taladb/next/server'

const hub = await openDB('sync-hub.db') // server-side TalaDB as the change store
export const { POST, GET } = createSyncHandlers({
  store: taladbSyncStore(hub),          // or memorySyncStore() for dev, or your own SyncStore
  authorize: async (req) => verifySession(req.headers.get('authorization')), // → per-user scope, 401 on null
})
```

```tsx
// app/providers.tsx — and the client side
'use client'
import { TalaDBProvider } from '@taladb/react'
import { SyncProvider } from '@taladb/next/client'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TalaDBProvider name="myapp.db" fallback={<Splash />}>
      <SyncProvider endpoint="/api/sync" headers={() => ({ Authorization: `Bearer ${getToken()}` })}>
        {children}
      </SyncProvider>
    </TalaDBProvider>
  )
}
```

`<TalaDBProvider name>` owns the client-only `openDB()` (SSR renders the fallback; hooks never see a missing db — `@taladb/react` ships `'use client'` so imports never trip the RSC boundary). `<SyncProvider>` drives `db.sync()` on start, every 30 s, on reconnect, and on tab focus. `authorize` is your security boundary: it returns a scope key (user id) and the store never mixes scopes.

Prefer to wire it manually — or on an older version? The one rule: **TalaDB is browser-only — keep it out of the server render.** Open the database lazily from client components:

```ts
// lib/db.ts — client-only singleton, safe to import anywhere
import type { TalaDB } from 'taladb'

let dbPromise: Promise<TalaDB> | undefined

export function getDB(): Promise<TalaDB> {
  if (typeof window === 'undefined') {
    throw new Error('TalaDB runs in the browser — call getDB() from client components/effects only')
  }
  dbPromise ??= import('taladb').then(({ openDB }) => openDB('myapp.db'))
  return dbPromise
}
```

```tsx
// app/sync-provider.tsx
'use client'
import { useEffect } from 'react'

export function SyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let stop = false
    const sync = async () => {
      if (stop) return
      const [{ HttpSyncAdapter }, { getDB }] = await Promise.all([import('taladb'), import('@/lib/db')])
      const db = await getDB()
      const adapter = new HttpSyncAdapter({
        endpoint: '/api/sync', // same-origin Next.js route handler — no CORS
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      await db.sync(adapter, {}).catch(() => {})
    }
    sync()
    const tick = setInterval(sync, 30_000)
    window.addEventListener('online', sync)
    return () => { stop = true; clearInterval(tick); window.removeEventListener('online', sync) }
  }, [])
  return <>{children}</>
}
```

Pointing the adapter at a **Next.js route handler** (`app/api/sync/push/route.ts` + `app/api/sync/pull/route.ts`) keeps everything same-origin; the handlers implement the [two-endpoint contract](#your-server-two-endpoints) against your database of choice.

### React Native

`taladb` + `@taladb/react-native` give you the same local-first database on iOS and Android today. **`db.sync()` on React Native lands in a future release** — the core engine already supports it; the changeset primitives are being exposed through the JSI binding. Until then `db.sync()` throws a clear error on RN.

Plan for these mobile realities when it arrives (the API will be identical):

- **Foreground sync is the baseline** — the same pattern as React, driven by `AppState` instead of `visibilitychange`: sync on launch, on `active`, and on an interval while the app is foregrounded. This alone covers most apps.
- **True background sync is OS-scheduled, not guaranteed.** iOS (BGTaskScheduler / background fetch, via e.g. `react-native-background-fetch`) requires the *Background Modes → Background fetch* capability and decides itself when your task runs; Android schedules through WorkManager with Doze/App-Standby restrictions and OEM battery managers on top. Design as "opportunistic catch-up in the background, guaranteed reconciliation on next launch" — never assume a background pass happened.
- **Sync before backgrounding** — an `AppState` listener firing a final pass on `background` is cheap insurance and needs no OS scheduling at all.

### Sync options

`db.sync(adapter, options)` — one pass, resolving to `{ pushed, pulled, cursor }`:

| Option | Default | Meaning |
|---|---|---|
| `collections` | all user collections | Allow-list of collections to sync |
| `exclude` | `[]` | Deny-list, applied after `collections` — `{ exclude: ['drafts'] }` = everything except drafts |
| `direction` | `'both'` | `'push'` (local → remote only, e.g. telemetry), `'pull'` (read-only local replica), `'both'` |
| `target` | `'default'` | Cursor namespace — give each remote its own (see [Multiple remotes](#multiple-remotes)) |

Reserved `_`-prefixed collections (including the internal cursor store) are never synced, regardless of options.

`new HttpSyncAdapter(options)`:

| Option | Default | Meaning |
|---|---|---|
| `endpoint` | — (required) | Base URL; `/push` and `/pull` are appended |
| `headers` | `{}` | Sent on every request — typically `Authorization` |
| `paths` | `{ push: '/push', pull: '/pull' }` | Override to match an existing API |
| `fetch` | global `fetch` | Inject for tests or non-standard runtimes |

```ts
await db.sync(adapter, {})                                        // everything, both ways
await db.sync(adapter, { collections: ['notes', 'tasks'] })      // scope
await db.sync(adapter, { collections: ['logs'], direction: 'push' })  // append-only telemetry
await db.sync(adapter, { collections: ['catalog'], direction: 'pull' }) // read-only mirror
```

### Your server: two endpoints

`HttpSyncAdapter` expects exactly two routes:

| Request | Meaning |
|---|---|
| `POST {endpoint}/push` — body is the changeset JSON | Store the incoming changes |
| `GET {endpoint}/pull?since={ms}` → changeset JSON | Return changes with `changed_at > since` |

Your server's whole job: keep the **latest change per document** on `/push`, return everything newer than `since` on `/pull`. Change records expose `collection`, `id`, and `changed_at` for exactly this; treat the rest of each record as opaque and store it verbatim. Here's a complete reference implementation (~20 lines of Express — swap the `Map` for a database table with an index on `changed_at`):

```js
import express from 'express'

const changes = new Map() // "<collection>::<id>" → latest change record

const app = express()
app.use(express.text({ type: '*/*' })) // the changeset body is a JSON string

app.post('/sync/push', (req, res) => {
  for (const change of JSON.parse(req.body)) {
    const key = `${change.collection}::${change.id}`
    const existing = changes.get(key)
    // Last-Write-Wins upsert: keep the newer change per document
    if (!existing || change.changed_at > existing.changed_at) changes.set(key, change)
  }
  res.sendStatus(204)
})

app.get('/sync/pull', (req, res) => {
  const since = Number(req.query.since ?? 0)
  res.json([...changes.values()].filter((c) => c.changed_at > since))
})

app.listen(3000)
```

**Multi-user apps:** the `Authorization` header identifies the caller; scope the change store per user (or per shared workspace) in your handlers. That per-user partition is your security boundary — the client never sees anyone else's changes because your `/pull` never returns them.

Prefer not to write a server at all? Run the [MongoDB adapter](#mongodb-adapter) inside your API handlers — your `/push` and `/pull` routes become one-liners over a MongoDB collection.

## Server → server

Everything above also works where TalaDB itself runs on a server or desktop: Electron main processes, backend read-replicas, CLI tools, or a fleet of Node.js edge instances converging through a shared store. Two extra options open up because a server can hold credentials:

- **Custom adapters over any transport** — see [Writing an adapter](#writing-an-adapter).
- **Direct-to-database sync** with `@taladb/sync-mongodb` — no intermediate API needed.

### MongoDB adapter

[`@taladb/sync-mongodb`](https://www.npmjs.com/package/@taladb/sync-mongodb) syncs a local TalaDB directly with a MongoDB collection.

::: danger Server-side only — never ship a database credential to a client
This adapter holds a MongoDB connection string. Run it **only** in a Node.js backend. It cannot run in a browser (the `mongodb` driver needs raw TCP), and you must never put a database credential in browser or mobile code — anyone can read it.

**For a web or mobile app, use the relay pattern from the client → server section:** the client runs `HttpSyncAdapter` pointed at *your* API with a user auth token; your server receives the changeset, authorizes the user, and runs `MongoSyncAdapter` server-side.

```
Browser TalaDB ──HttpSyncAdapter (HTTPS + user token)──▶ Your Node API ──MongoSyncAdapter──▶ MongoDB
   (no secrets)                                          (holds the Mongo credential)
```
:::

```bash
npm install @taladb/sync-mongodb mongodb
```

```ts
import { MongoSyncAdapter } from '@taladb/sync-mongodb';

// Let the adapter open the connection…
const { adapter, close } = await MongoSyncAdapter.connect({
  uri: process.env.MONGO_URI!,
  db: 'sync',
});
await db.sync(adapter, { collections: ['notes'] });
await close();
```

Or pass a collection from your own `MongoClient` when the app owns the connection lifecycle:

```ts
import { MongoClient } from 'mongodb';
import { MongoSyncAdapter } from '@taladb/sync-mongodb';

const client = new MongoClient(process.env.MONGO_URI!);
await client.connect();
const store = client.db('sync').collection('taladb_changes');
await store.createIndex({ changed_at: 1 }); // pull performance
const adapter = new MongoSyncAdapter({ collection: store });
```

**How it stores data.** One document per synced TalaDB document (`_id = "<collection>::<docId>"`), holding the latest change plus its `changed_at`. Push does a Last-Write-Wins conditional upsert (newer timestamp wins, correct even when several peers push the same document out of order); pull returns every change newer than the caller's cursor. Any number of TalaDB peers syncing to the same MongoDB store converge through it — so it doubles as a lightweight sync hub for a fleet of clients.

## How it works

Each pass:

1. **Reads the cursors** — two per-target watermarks persisted in a reserved `__taladb_sync` collection (hidden from `listCollectionNames`, never itself synced): `pushMs`, a local-clock watermark for exports, and `pullMs`, the newest remote `changed_at` actually received so far.
2. **Snapshots local changes** since `pushMs` *before* importing anything, so a change just pulled from the remote is never echoed straight back.
3. **Pulls** the remote changeset (changes after `pullMs`) and merges it Last-Write-Wins.
4. **Pushes** the local snapshot.
5. **Advances the cursors** — `pushMs` to the pass's start time, `pullMs` only past changes actually received. The split matters: a remote change *authored* before your last pass but *arriving* at the server after it would be skipped forever by a single local-clock watermark; tracking received-`changed_at` keeps every late arrival fetchable.

### Conflict resolution

When the same document changed on both sides, **Last-Write-Wins** by `changed_at` timestamp keeps the newer version; equal timestamps break ties deterministically (so every replica converges without coordination), and deletes win ties against upserts. Every write carries a `changed_at` stamp automatically.

### Idempotency

`importChanges` only applies strictly-newer changes, so re-delivering a changeset — after a dropped connection or an at-least-once transport — is a safe no-op. This is what makes the incremental cursors robust: a small overlap between passes never double-applies, and a failed pass simply retries next time (cursors advance only on success).

## Multiple remotes

Give each remote its own `target` so their cursors stay independent:

```ts
await db.sync(primaryAdapter, { collections: ['notes'], target: 'primary' });
await db.sync(backupAdapter,  { collections: ['notes'], target: 'backup' });
```

## Writing an adapter

`HttpSyncAdapter` is a reference implementation. Any transport works — implement two methods:

```ts
import type { SyncAdapter } from 'taladb';

const adapter: SyncAdapter = {
  // Send a serialized changeset to the remote.
  async push(changeset) {
    await myTransport.send(changeset);
  },
  // Return remote changes with changed_at after `sinceMs`, serialized.
  // Return '[]' when there is nothing new.
  async pull(sinceMs) {
    return myTransport.fetchSince(sinceMs);
  },
};
```

The changeset is an opaque JSON string produced and consumed by TalaDB — your transport and server only store and range-query it by timestamp. Implement just `push` for a push-only adapter, just `pull` for pull-only.

## Low-level API

`sync()` is built on two primitives you can call directly if you need custom orchestration:

```ts
const changeset = await db.exportChanges(['notes'], sinceMs); // → serialized changeset
const applied   = await db.importChanges(changeset);          // → number of docs changed
```

## Relationship to the other sync options

- **[HTTP Push Sync](/guide/http-sync)** — one-way, fire-and-forget webhooks/analytics. No pull, no cursor. Keep using it for outbound event streams.
- **[CRDT Sync](/guide/crdt-sync)** — richer merge semantics for concurrent edits to the same field.
- **Bidirectional sync** (this page) — the two-way replication loop with LWW and cursors.

For real-time, multi-user sync with offline queueing and exactly-once delivery, the planned [`@taladb/sync-recached`](/roadmap) adapter will run this same interface over [Recached](https://recached.dev).
