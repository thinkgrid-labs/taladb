---
title: Roadmap
description: Planned and in-progress features for TalaDB — ordered by impact and priority.
---

# Roadmap

This page tracks planned and in-progress work for TalaDB. Sections and items are ordered by estimated impact — things at the top affect the most users and unblock the most use cases.

Have an idea or want to help prioritise? Open a [GitHub Discussion](https://github.com/thinkgrid-labs/taladb/discussions) or a feature request issue.

---

## 1 · Developer experience

Better DX drives adoption and reduces time-to-production.

### Sync 

- Native NoSQL adapters (`sync.adapter: mongodb | firestore | dynamodb`) with direct connection strings, removing the need for an intermediate API
- Bi-directional pull: `taladb sync --pull` fetches from the remote and merges locally
- Per-collection sync config (sync some collections, skip others)

### Aggregation API

A pipeline-style aggregation API for computing summaries inside the engine without materialising every document in JavaScript:

- `collection.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])`
- Supported stages (v1): `$match`, `$group`, `$sort`, `$limit`, `$project`
- Group accumulators: `$sum`, `$count`, `$avg`, `$min`, `$max`
- Runs as a single pass over the B-tree / index; result never fully materialised in Rust heap for large collections

### Compound indexes

Multi-field B-tree indexes so queries filtered or sorted on two or more fields use an index scan instead of a full-collection scan:

- `collection.createIndex(['userId', 'createdAt'])` — composite key, ascending by default
- Descending order per field: `createIndex([['userId', 'asc'], ['createdAt', 'desc']])`
- Query planner selects the compound index automatically when the leading field matches the filter

### `taladb generate` — TypeScript type generation

Inspect a live database and emit TypeScript interfaces for each collection, inferred from the stored documents. Useful for projects that don't start with a schema.

### Framework adapters — Svelte and Vue

- **`@taladb/svelte`** — `readable` stores backed by `Collection.subscribe`, plus a `TalaDBContext` Svelte context helper. `$findResult` is a readable store that re-derives on every write matching the filter.
- **`@taladb/vue`** — `useFind` and `useFindOne` composables built on Vue's `ref` + `watchEffect`, mirroring the `@taladb/react` hook API.

Both packages are thin wrappers over the same event model used by the React hooks.

### First-party sync backend adapters

Thin adapter packages that implement the `SyncAdapter` interface for popular backends, so no custom server is required:

- **`@taladb/sync-supabase`** — uses a Supabase table + Realtime channel as the changeset transport
- **`@taladb/sync-turso`** — writes changesets to a Turso (libSQL) table; useful for Electron and server-side apps
- **`@taladb/sync-d1`** — Cloudflare D1 table as the sync relay; pairs naturally with `@taladb/cloudflare`

Each adapter handles auth, changeset serialisation, and incremental polling/push. CRDT or LWW merge is still applied client-side.

### VS Code extension

Syntax highlighting for TalaDB filter expressions in JSON, inline document previews, and a collection browser panel in the VS Code sidebar.

---

## 2 · Advanced sync

### Sync over WebSockets

The CRDT merge protocol (field-level logical clocks, `CrdtSyncAdapter`) shipped in **v0.7.11**. What remains is the transport: a reference sync server (`taladb-sync-server`) that accepts changesets over a persistent WebSocket connection and fans them out to connected peers, enabling multi-device sync without a managed cloud database. Merge logic stays client-side via `import_crdt_changes`.

---

## 3 · Storage

Internal improvements that improve efficiency and interoperability.

### Pluggable serialisation

Allow the caller to swap `postcard` for `MessagePack` or `CBOR` via a `Codec` trait, making it easier to interoperate with databases or wire formats that already use those encodings.

### Document TTL (time-to-live)

Set an expiry on any document at write time:

- `collection.insert({ ...doc, _ttl: Date.now() + 60_000 })` — document auto-deleted after the TTL elapses
- Background reaper runs on a configurable interval (default: 60 s in Node.js, on next open in browser)
- Tombstone generated for TTL deletions so expiry propagates correctly through sync

---

## 4 · Platform

Expanding the runtimes TalaDB can target.

### Swift / Kotlin native packages

First-party Swift (`TalaDB.swift`) and Kotlin (`taladb-kotlin`) packages that wrap the C FFI layer directly, without React Native, for native iOS and Android apps that want an embedded document store.

### WASI target

Compile `taladb-core` to WASI (`wasm32-wasip1`) so it can run inside WASI runtimes (Wasmtime, WasmEdge, Fastly Compute) with filesystem access — bringing the same engine to server-side WASM environments.
