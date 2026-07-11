---
title: Roadmap
description: Planned and in-progress features for TalaDB
---

# Roadmap

This page tracks planned and in-progress work for TalaDB. Sections and items are ordered by estimated impact — things at the top affect the most users and unblock the most use cases.

Have an idea or want to help prioritise? Open a [GitHub Discussion](https://github.com/thinkgrid-labs/taladb/discussions) or a feature request issue.

---

## 1 · Developer experience

Better DX drives adoption and reduces time-to-production.

### Sync

- ✅ **Bidirectional sync** *(shipped: Node.js + browser)* — `db.sync(adapter, { collections, direction })` pulls remote changes and pushes local ones with Last-Write-Wins merge and incremental cursors. Ships with a reference `HttpSyncAdapter`; any transport plugs in via the `SyncAdapter` interface. In the browser (v0.8.5) the whole sync pass runs inside the Dedicated Worker, off the main thread. See [Bidirectional Sync](/guide/bidirectional-sync). *Next: React Native — expose the changeset primitives through the C FFI / JSI binding (the core engine already supports it), ship an `AppState`-driven sync example, and document background-sync integration (iOS BGTaskScheduler / Android WorkManager via e.g. `react-native-background-fetch`) — mobile background execution is OS-scheduled, so the guide will teach "opportunistic background catch-up, guaranteed reconciliation on launch".*
- **Server-assigned sync sequence cursor** — pull filtering currently relies on `changed_at` timestamps (see the two-watermark design in the guide); a server-assigned monotonic sequence would make pull cursors fully robust against clock skew between peers. Requires a small `SyncAdapter` contract extension.
- Native NoSQL adapters — for **server-side** TalaDB, sync directly to a database with no intermediate API. (Browser/mobile apps still relay through your own API — a database credential must never reach a client.)
  - ✅ **`@taladb/sync-mongodb`** *(shipped)* — Last-Write-Wins conditional upsert into a MongoDB collection; also acts as a sync hub for a fleet of peers. Server-side only. See [Bidirectional Sync → MongoDB adapter](/guide/bidirectional-sync#mongodb-adapter).
  - `@taladb/sync-firestore`, `@taladb/sync-dynamodb` — same `SyncAdapter` interface, next up.
- ✅ **Per-collection sync** *(shipped)* — `db.sync()` syncs all collections by default; scope with `collections` (allow-list) or `exclude` (deny-list). Reserved `_`-prefixed collections are never synced. See [Bidirectional Sync → Selecting collections](/guide/bidirectional-sync#selecting-collections).

### Aggregation API

✅ **Shipped (all runtimes)** — a pipeline-style aggregation API for computing summaries inside the engine without materialising every document in JavaScript. Available on Node.js, the browser (direct + OPFS worker), and React Native. See [Aggregation](/api/aggregation).

- `collection.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])`
- Stages: `$match`, `$group`, `$sort`, `$skip`, `$limit`, `$project`
- Group accumulators: `$sum`, `$count`, `$avg`, `$min`, `$max`, `$push`, `$addToSet`, `$first`, `$last`
- Runs as a single pass over the B-tree / index; `$match` as the first stage uses an index

### Compound indexes

Multi-field B-tree indexes so queries filtered or sorted on two or more fields use an index scan instead of a full-collection scan:

- `collection.createIndex(['userId', 'createdAt'])` — composite key, ascending by default
- Descending order per field: `createIndex([['userId', 'asc'], ['createdAt', 'desc']])`
- Query planner selects the compound index automatically when the leading field matches the filter

### `taladb generate` — TypeScript type generation

Inspect a live database and emit TypeScript interfaces for each collection, inferred from the stored documents. Useful for projects that don't start with a schema.

### `@taladb/react` — drop-in Next.js client support

The hooks already work in Next.js client components (SSR renders `loading: true` via `getServerSnapshot`, then hydrates live). Two small additions remove the remaining ceremony:

- Ship the `'use client'` directive in the build output (the SWR / react-query convention), so importing the hooks never trips the RSC boundary
- `<TalaDBProvider name="myapp.db">` — a name-based provider that owns the lazy, client-only `openDB()`, replacing today's hand-rolled async-open-then-provide dance. The existing `db`-prop form stays for React Native and plain React

One package, zero forks: the same `@taladb/react` serves React, React Native, and Next.js client components.

### `@taladb/next` — first-party Next.js integration

Next.js can never render a user's on-device data in server components — the honest server story is that **your Next API routes are the sync backend**. This package makes that one line on each side:

- **`@taladb/next/server`** — `createSyncHandlers({ store, authorize })` returns `{ POST, GET }` route handlers implementing the [two-endpoint sync contract](/guide/bidirectional-sync#your-server-two-endpoints). `store` is pluggable: in-memory (dev), a server-side TalaDB via `@taladb/node` (the batteries-included default — TalaDB syncing to TalaDB), or MongoDB via `@taladb/sync-mongodb`. `authorize(req)` returns a scope key, giving per-user change partitioning — the security boundary — for free.
- **`@taladb/next/client`** — `<SyncProvider endpoint="/api/sync" interval={30_000}>`, packaging the guide's start/interval/online/visibility cadence.

Subpath exports (`/server`, `/client`) follow the next-auth convention and keep the RSC boundary explicit in the import path. Ships with an example app and e2e tests against a real Next.js build.

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
