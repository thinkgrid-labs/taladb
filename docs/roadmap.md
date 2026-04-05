---
title: Roadmap
description: Planned and in-progress features for TalaDB — ordered by impact and priority.
---

# Roadmap

This page tracks planned and in-progress work for TalaDB. Sections and items are ordered by estimated impact — things at the top affect the most users and unblock the most use cases.

Have an idea or want to help prioritise? Open a [GitHub Discussion](https://github.com/thinkgrid-labs/taladb/discussions) or a feature request issue.

---

## 1 · Browser fundamentals

These are gaps that affect every browser app today.

### Multi-tab live queries (BroadcastChannel)

Currently each browser tab spawns its own DedicatedWorker and acquires an exclusive Web Locks lock on the OPFS file — tabs do not conflict, but writes in one tab are not visible to another tab's `subscribe()` callbacks until that tab reloads and re-opens the database.

The planned fix keeps the DedicatedWorker + Web Locks architecture (required because `createSyncAccessHandle` is only available in DedicatedWorkers) and adds a `BroadcastChannel` layer on top:

- When a tab's worker commits a write it posts a `"taladb:changed"` message on a named `BroadcastChannel`
- All other tabs receive the message and re-trigger their active `subscribe()` pollers immediately, without waiting for the next 300 ms tick
- No OPFS locking changes are needed — reads are lock-free; only writes hold the exclusive handle momentarily

Result: inserts, updates, and deletes in tab A appear in tab B's live-query subscriptions within one round-trip, matching the experience users expect from a shared database.

### IndexedDB fallback backend

A complete `StorageBackend` implementation on top of IndexedDB for browsers that will never support OPFS (e.g. cross-origin iframes). Currently the fallback is in-memory only — data is lost on page reload in these environments.

---

## 2 · Vector search (HNSW)

v0.3 ships flat (brute-force) vector search — O(n·d) per query, perfect for collections up to ~10 K documents. The next step replaces the inner loop with an HNSW (Hierarchical Navigable Small World) graph index for sub-linear approximate nearest-neighbor search, making vector search viable for production-scale collections.

### Planned design

- **Crate:** [`instant-distance`](https://github.com/instant-labs/instant-distance) — pure Rust, WASM-compatible, MIT license
- **Persistence:** HNSW graph serialised to a dedicated `hnsw::<collection>::<field>` redb table as a single blob; loaded into memory on database open
- **Feature flag:** `--features vector-hnsw` keeps the base WASM bundle lean; flat search remains the default and is used automatically for small collections
- **API:** fully backward-compatible — same `createVectorIndex` / `findNearest` calls, new `indexType` option:

```ts
await col.createVectorIndex('embedding', {
  dimensions: 384,
  metric: 'cosine',
  indexType: 'hnsw',       // 'flat' (default) | 'hnsw'
  hnswM: 16,               // connectivity — higher = better recall, more memory
  hnswEfConstruction: 200, // build-time quality
})
```

- **Auto-upgrade:** `taladb upgrade-vector-index <file> <collection> <field>` CLI command promotes a flat index to HNSW in-place without re-inserting documents
- **Target performance:** <5 ms `findNearest` on 100 K 384-dim vectors on a mid-range device

---

## 3 · Query engine

Features that almost every real application needs before it can ship.

### Cursor / pagination

`find(filter, { skip: 0, limit: 20, sort: { createdAt: -1 } })` — stable, index-aware pagination without loading the entire result set into memory. Blocking for any app with a list view.

### Nested field queries

Dot-notation access to nested object fields — `{ 'address.city': 'London' }` — without requiring the caller to flatten documents before inserting.

### Compound indexes

Index a tuple of fields `(lastName, firstName)` so that queries with equality on `lastName` and a range on `firstName` use a single B-tree scan instead of two separate index scans with an in-memory join.

### Aggregation pipeline

A lightweight `aggregate()` method supporting `$group`, `$sum`, `$avg`, `$min`, `$max`, `$count`, and `$sort` — enough to power dashboards and analytics views without moving data out of the database.

### Projection

`find(filter, { fields: ['name', 'email'] })` — return only specified fields, reducing deserialization cost for wide documents with many fields.

### `$regex` filter

Pattern matching against string fields using a compiled regex. Evaluated as a post-filter (no index support) but useful for search and validation.

---

## 4 · Developer experience

Better DX drives adoption and reduces time-to-production.

### React hooks package (`@taladb/react`)

First-party `useCollection`, `useWatch`, `useFind`, and `useFindOne` hooks that integrate with React's `useSyncExternalStore` for zero-tearing live query snapshots in concurrent React. The primary audience is React developers — this is the highest-leverage DX investment.

### `taladb studio` — local web UI

A browser-based GUI (served by `taladb-cli`) for browsing collections, running ad-hoc queries, inspecting indexes, and visualising query plans — similar to MongoDB Compass but for local files.

### Zod / Valibot schema validation

An optional `schema` option on `collection()` that validates documents with a Zod or Valibot schema before insert and after find, providing runtime type safety without a compile step.

### `taladb generate` — TypeScript type generation

Inspect a live database and emit TypeScript interfaces for each collection, inferred from the stored documents. Useful for projects that don't start with a schema.

### VS Code extension

Syntax highlighting for TalaDB filter expressions in JSON, inline document previews, and a collection browser panel in the VS Code sidebar.

---

## 5 · Sync

Multi-device and collaborative data sync — the next frontier for local-first apps.

### Conflict-free sync with CRDTs

A `CrdtSyncAdapter` that uses per-field logical clocks (LWW-register or grow-only sets) to merge concurrent writes from multiple devices without conflicts — suitable for collaborative offline-first apps.

### Delta snapshots

Instead of exporting the full database on every sync, export only the records that changed since a given ULID watermark — reducing bandwidth for incremental sync scenarios. Foundation for the sync server below.

### Sync over WebSockets

A reference sync server (`taladb-sync-server`) that accepts snapshot diffs over a WebSocket connection and applies `LastWriteWins` or CRDT merge logic server-side, enabling multi-device sync without a cloud database.

---

## 6 · Storage

Internal improvements that improve efficiency and interoperability.

### Write-ahead log compaction

redb already handles WAL compaction internally, but exposing a `db.compact()` API for explicit compaction (e.g. after bulk deletes) would let long-running applications reclaim disk space on demand.

### Pluggable serialisation

Allow the caller to swap `postcard` for `MessagePack` or `CBOR` via a `Codec` trait, making it easier to interoperate with databases or wire formats that already use those encodings.

---

## 7 · Platform

Expanding the runtimes TalaDB can target.

### Cloudflare Workers / Deno Deploy

A `StorageBackend` implementation backed by Cloudflare's `KV` or `Durable Objects` API, letting TalaDB run as the persistence layer inside an edge function with zero external dependencies.

### Bun native module

A Bun-native binding (using Bun's `bun:ffi`) that avoids the N-API layer for better startup performance and smaller binary size in Bun-first projects.

### Swift / Kotlin native packages

First-party Swift (`TalaDB.swift`) and Kotlin (`taladb-kotlin`) packages that wrap the C FFI layer directly, without React Native, for native iOS and Android apps that want an embedded document store.

### WASI target

Compile `taladb-core` to WASI (`wasm32-wasip1`) so it can run inside WASI runtimes (Wasmtime, WasmEdge, Fastly Compute) with filesystem access — bringing the same engine to server-side WASM environments.

---

## 8 · Security

Hardening for apps that handle sensitive data.

### Key rotation

A `db.rekey(newKey)` method that re-encrypts all stored values in a single atomic transaction without requiring an export/import cycle.

### Field-level encryption

Encrypt individual fields rather than entire values, so that unencrypted fields can still be indexed and used in range queries while sensitive fields (e.g. `ssn`, `creditCard`) are protected at rest.

### Audit log

An append-only `_audit` collection that records every write operation (collection, document ID, operation type, timestamp) — opt-in, with configurable retention.
