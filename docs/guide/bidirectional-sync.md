---
title: Bidirectional Sync
description: Two-way sync between a local TalaDB and a remote peer — pull remote changes, push local changes, with Last-Write-Wins conflict resolution and an incremental cursor.
---

# Bidirectional Sync

[HTTP Push Sync](/guide/http-sync) is fire-and-forget: it POSTs every local write outward and never hears back. **Bidirectional sync** is the full loop — pull remote changes into the local database *and* push local changes out, tracked by a cursor so each pass is incremental, with automatic Last-Write-Wins conflict resolution.

::: info Runtime support
Available on **Node.js** today. Browser (WASM) and React Native share the same engine and API; their binding wiring is in progress — calling `db.sync()` there throws a clear error until then. Track it on the [roadmap](/roadmap).
:::

## One call

```ts
import { openDB, HttpSyncAdapter } from 'taladb';

const db = await openDB('app.db');

const adapter = new HttpSyncAdapter({
  endpoint: 'https://api.example.com/sync',
  headers: { Authorization: `Bearer ${token}` },
});

// Pull remote changes, then push local ones. Incremental after the first pass.
const { pulled, pushed } = await db.sync(adapter, { collections: ['notes', 'tasks'] });
```

Call it on an interval, on reconnect, or after a batch of writes — each pass only exchanges what changed since the last one.

## Direction

Bidirectional is the default. Narrow it when you only want one way:

```ts
await db.sync(adapter, { collections: ['notes'] });                      // both (default)
await db.sync(adapter, { collections: ['logs'], direction: 'push' });    // local → remote only
await db.sync(adapter, { collections: ['catalog'], direction: 'pull' }); // remote → local only
```

- **`push`** — send local changes; ignore the remote. Good for append-only telemetry.
- **`pull`** — mirror central data into a read-only local replica (e.g. a shared catalog).
- **`both`** — full two-way sync.

## How it works

Each pass:

1. **Reads the cursor** — a per-target millisecond watermark persisted in a reserved `__taladb_sync` collection (hidden from `listCollectionNames`, never itself synced).
2. **Snapshots local changes** since the cursor *before* importing anything, so a change just pulled from the remote is never echoed straight back.
3. **Pulls** the remote changeset (changes after the cursor) and merges it Last-Write-Wins.
4. **Pushes** the local snapshot.
5. **Advances the cursor.**

### Conflict resolution

When the same document changed on both sides, **Last-Write-Wins** by `changed_at` timestamp keeps the newer version; equal timestamps break ties deterministically (so every replica converges without coordination), and deletes win ties against upserts. Every write carries a `changed_at` stamp automatically.

### Idempotency

`importChanges` only applies strictly-newer changes, so re-delivering a changeset — after a dropped connection or an at-least-once transport — is a safe no-op. This is what makes the incremental cursor robust: a small overlap between passes never double-applies.

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

### The HTTP contract

`HttpSyncAdapter` expects two endpoints on your server:

| Request | Meaning |
|---|---|
| `POST {endpoint}/push` — body is the changeset JSON | Store the incoming changes |
| `GET {endpoint}/pull?since={ms}` → changeset JSON | Return changes with `changed_at > since` |

A minimal server stores each pushed change keyed by `changed_at` and, on pull, returns everything newer than `since`.

## Low-level API

`sync()` is built on two primitives you can call directly if you need custom orchestration:

```ts
const changeset = await db.exportChanges(['notes'], sinceMs); // → serialized changeset
const applied   = await db.importChanges(changeset);          // → number of docs changed
```

## MongoDB adapter

[`@taladb/sync-mongodb`](https://www.npmjs.com/package/@taladb/sync-mongodb) syncs a local TalaDB directly with a MongoDB collection — no intermediate API needed when TalaDB itself runs on a server.

::: danger Server-side only — never ship a database credential to a client
This adapter holds a MongoDB connection string. Run it **only** in a Node.js backend. It cannot run in a browser (the `mongodb` driver needs raw TCP), and you must never put a database credential in browser or mobile code — anyone can read it.

**For a web or mobile app, use a relay:** the client runs [`HttpSyncAdapter`](#writing-an-adapter) pointed at *your* API with a user auth token; your server receives the changeset, authorizes the user, and runs `MongoSyncAdapter` server-side. That intermediate API is your security boundary.

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

## Relationship to the other sync options

- **[HTTP Push Sync](/guide/http-sync)** — one-way, fire-and-forget webhooks/analytics. No pull, no cursor. Keep using it for outbound event streams.
- **[CRDT Sync](/guide/crdt-sync)** — richer merge semantics for concurrent edits to the same field.
- **Bidirectional sync** (this page) — the two-way replication loop with LWW and a cursor.

For real-time, multi-user sync with offline queueing and exactly-once delivery, the planned [`@taladb/sync-recached`](/roadmap) adapter will run this same interface over [Recached](https://recached.dev).
