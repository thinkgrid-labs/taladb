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

- **`@taladb/sync-recached`** — uses [Recached](https://recached.dev), our sibling sync fabric, as the transport. Unlike the poll-based adapters below, this one is push-native: scoped live queries deliver changes in real time, and Recached's durable outbox provides offline queueing and exactly-once delivery, so the adapter inherits reconnect and conflict handling rather than reimplementing them. The flagship adapter for real-time, multi-user apps.
- **`@taladb/sync-supabase`** — uses a Supabase table + Realtime channel as the changeset transport
- **`@taladb/sync-turso`** — writes changesets to a Turso (libSQL) table; useful for Electron and server-side apps
- **`@taladb/sync-d1`** — Cloudflare D1 table as the sync relay; pairs naturally with `@taladb/cloudflare`

Each adapter handles auth, changeset serialisation, and incremental polling/push. CRDT or LWW merge is still applied client-side.

### VS Code extension

Syntax highlighting for TalaDB filter expressions in JSON, inline document previews, and a collection browser panel in the VS Code sidebar.

---

## 2 · Performance & vector search

Driven by findings from the v0.8.3 [benchmark suites](/benchmarks) (`pnpm bench`, `pnpm bench:web`).

### Query planner — bounded range plans

A two-sided range (`$gte` + `$lt` on the same field) currently uses the index for the lower bound only and post-filters the rest — ~463 ms for a ~100-doc window at 100k docs, versus 1.4 ms for the one-sided form:

- Emit a single bounded index scan when both bounds constrain the same indexed field
- Extend to `$in` + range combinations on compound indexes once those land

### Non-blocking HNSW graph builds

`createVectorIndex(..., { indexType: 'hnsw' })` blocks while the graph is constructed — tens of minutes at 50k × 384-dim on laptop hardware:

- Build on a background thread with an `onProgress` callback; queries fall back to the flat scan until the graph is ready
- Incremental graph inserts, so steady-state writes don't require a full `upgradeVectorIndex` rebuild
- Document expected build cost by collection size so apps can schedule rebuilds during idle periods

### Faster hybrid pre-filters

`findNearest` with a pre-filter materialises every matching document — including its embedding array — just to collect ids. An id-only execution path in the query executor would make hybrid queries substantially cheaper at scale.

### HNSW on web and React Native

The `vector-hnsw` feature ships in `@taladb/node` since v0.8.3 but not in the WASM or JSI builds. Evaluate enabling it per platform: WASM bundle size, mobile memory ceilings, and graph build time on phone CPUs all need numbers first.

### WASM SIMD for vector search

Browser flat-scan search already runs at parity with the native module. Chrome and Safari both ship WASM SIMD — a `+simd128` build (with runtime feature detection and a scalar fallback) could deliver a multi-× speedup on dot products, the hot loop of `findNearest`.

### Continuous benchmarks

Run the Node and browser suites in CI on a fixed runner class per release and publish the trend, so performance regressions are caught before they ship. Extend with a React Native suite (the one runtime not yet covered).

---

## 3 · Advanced sync

### Sync over WebSockets

The CRDT merge protocol (field-level logical clocks, `CrdtSyncAdapter`) shipped in **v0.7.11**. What remains is the transport: a reference sync server (`taladb-sync-server`) that accepts changesets over a persistent WebSocket connection and fans them out to connected peers, enabling multi-device sync without a managed cloud database. Merge logic stays client-side via `import_crdt_changes`.

---

## 4 · Storage

Internal improvements that improve efficiency and interoperability.

### Configurable browser durability

The browser engine persists a snapshot to OPFS on a fixed 500 ms debounce, so a hard crash can lose the most recent writes (see [benchmarks](/benchmarks) for the trade-off this buys). Expose it per `openDB`:

- `durability: { flushMs?: number, flushEveryWrite?: boolean }` — tune the debounce, or opt into flush-per-commit for apps where the last write matters more than write throughput
- `db.flush()` — explicit await-able flush for "save now" moments (before checkout, on visibilitychange)

### Pluggable serialisation

Allow the caller to swap `postcard` for `MessagePack` or `CBOR` via a `Codec` trait, making it easier to interoperate with databases or wire formats that already use those encodings.

### Document TTL (time-to-live)

Set an expiry on any document at write time:

- `collection.insert({ ...doc, _ttl: Date.now() + 60_000 })` — document auto-deleted after the TTL elapses
- Background reaper runs on a configurable interval (default: 60 s in Node.js, on next open in browser)
- Tombstone generated for TTL deletions so expiry propagates correctly through sync

---

## 5 · Platform

Expanding the runtimes TalaDB can target.

### Swift / Kotlin native packages

First-party Swift (`TalaDB.swift`) and Kotlin (`taladb-kotlin`) packages that wrap the C FFI layer directly, without React Native, for native iOS and Android apps that want an embedded document store.

### WASI target

Compile `taladb-core` to WASI (`wasm32-wasip1`) so it can run inside WASI runtimes (Wasmtime, WasmEdge, Fastly Compute) with filesystem access — bringing the same engine to server-side WASM environments.
