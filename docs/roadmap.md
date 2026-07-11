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

- ✅ **Bidirectional sync** *(shipped: Node.js + browser)* — `db.sync(adapter, { collections, direction })` pulls remote changes and pushes local ones with Last-Write-Wins merge and incremental cursors. Ships with a reference `HttpSyncAdapter`; any transport plugs in via the `SyncAdapter` interface. In the browser (v0.9.0) the whole sync pass runs inside the Dedicated Worker, off the main thread. See [Bidirectional Sync](/guide/bidirectional-sync). *Next: React Native — expose the changeset primitives through the C FFI / JSI binding (the core engine already supports it), ship an `AppState`-driven sync example, and document background-sync integration (iOS BGTaskScheduler / Android WorkManager via e.g. `react-native-background-fetch`) — mobile background execution is OS-scheduled, so the guide will teach "opportunistic background catch-up, guaranteed reconciliation on launch".*
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

### ✅ `@taladb/react` — drop-in Next.js client support

The build output ships the `'use client'` directive (the SWR / react-query convention), and `<TalaDBProvider name="myapp.db" fallback={…}>` owns the lazy, client-only `openDB()` lifecycle — children render only once the db is ready, so hooks never observe a missing instance. The `db`-prop form stays for React Native and plain React. One package, zero forks.

### ✅ `@taladb/next` — first-party Next.js integration

Next.js can never render a user's on-device data in server components — the honest server story is that **your Next API routes are the sync backend**. This package makes that one line on each side:

- **`@taladb/next/server`** — `createSyncHandlers({ store, authorize })` returns `{ POST, GET }` route handlers implementing the [two-endpoint sync contract](/guide/bidirectional-sync#your-server-two-endpoints). `store` is pluggable: in-memory (dev), a server-side TalaDB via `@taladb/node` (the batteries-included default — TalaDB syncing to TalaDB), or MongoDB via `@taladb/sync-mongodb`. `authorize(req)` returns a scope key, giving per-user change partitioning — the security boundary — for free.
- **`@taladb/next/client`** — `<SyncProvider endpoint="/api/sync" interval={30_000}>`, packaging the guide's start/interval/online/visibility cadence.

Subpath exports (`/server`, `/client`) follow the next-auth convention and keep the RSC boundary explicit in the import path. Verified end-to-end (real Chrome client → handlers → TalaDB-backed store), plus `examples/nextjs-sync` in the repo — CI runs a real `next build` over it.

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

Driven by findings from the [benchmark suites](/benchmarks) (`pnpm bench`, `pnpm bench:web`). The goal: keep TalaDB among the fastest embedded databases on every JS runtime.

### ✅ Faster flat vector search *(shipped in v0.9.x)*

The brute-force `findNearest` scoring loop was rewritten and is now **~2× faster** (measured on the benchmark laptop: 100k × 384-dim from 369 ms → ~197 ms; 10k from 40 ms → ~18 ms). Four changes, all in the core scan:

- **Score straight from stored bytes** — the old path decoded every stored vector into a fresh `Vec<f32>` (one heap allocation per vector per query, ~100k/query at scale) before scoring. Scoring now streams f32s directly from the raw LE bytes, so the allocation storm is gone.
- **Hoist the query norm** — `cosine_similarity` recomputed the *query's* own L2 norm against every candidate; it's constant, so it's now computed once per query.
- **Top-k by partial selection** — `select_nth_unstable` (O(n) average) replaces the full O(n log n) sort over all candidates; only the k results are then ordered.
- **Filter-first for hybrid** — a pre-filter now resolves to an id set *before* the scan, so filtered-out vectors are never scored (a 10 %-selective filter skips 90 % of the work).

### Cached decoded vectors — avoid re-reading storage per query

The flat path still `scan_all`s the entire vector table from redb on **every** query (150 MB of reads for 100k × 384-dim). A persistent in-memory decoded-vector cache — invalidated on writes, mirroring the existing HNSW-graph cache — would make repeated queries memory-bound instead of storage-bound. Likely the single largest remaining flat-search win.

### SIMD dot products — WASM (validated) + native

The scoring reductions are scalar today. The WASM lever is **measured and confirmed**, and productizing it is the top browser-perf task:

- **WASM** — a `+simd128` build was A/B'd on the benchmark laptop and **~halves** browser vector search (50k: 172 ms → 81 ms; 10k: 35 ms → 17 ms), restoring near-native parity. The remaining work is *shipping* it safely: a single simd128 module fails to instantiate on browsers without WASM SIMD (Safari 15.2–16.3, which TalaDB otherwise supports via OPFS), so this needs either dual builds with runtime feature detection (load simd or scalar `.wasm`) or a deliberate baseline bump to simd128-capable browsers. The build itself is just `RUSTFLAGS="-C target-feature=+simd128"` — LLVM autovectorizes the v0.9.0 byte-streaming loops with no code change. (Also: the `release-wasm` profile in `Cargo.toml` sets `opt-level = "z"` but is *unused* — remove it so nobody ships size-optimized vectors by accident.)
- **Native**: the release profile sets no `target-cpu`, so distributed binaries can't assume AVX2/NEON. An explicit `std::simd` (or chunked-FMA) dot-product kernel with runtime feature detection would vectorise the multiply-add without breaking portability of the prebuilt `.node`.

### ✅ Query planner — bounded range plans *(shipped in v0.9.0)*

A two-sided range (`$gte` + `$lt` on the same indexed field) is now planned as **one bounded index scan** instead of a half-open scan that post-filtered the far bound over the whole tail. Measured: a ~100-doc `publishedAt` window at 100k docs dropped from ~463 ms to **0.76 ms** (~600×). The combined plan covers both Int- and Float-typed index entries (keys are type-prefixed) and a cross-type parity test asserts it returns exactly the unindexed result.

- ⬜ Still to do: extend to `$in` + range combinations on compound indexes once those land.

### Non-blocking HNSW graph builds

`createVectorIndex(..., { indexType: 'hnsw' })` blocks while the graph is constructed — tens of minutes at 50k × 384-dim on laptop hardware:

- Build on a background thread with an `onProgress` callback; queries fall back to the flat scan until the graph is ready
- Incremental graph inserts, so steady-state writes don't require a full `upgradeVectorIndex` rebuild
- Document expected build cost by collection size so apps can schedule rebuilds during idle periods

### Faster hybrid pre-filters (id-only path)

The [v0.9.x scan rewrite](#faster-flat-vector-search-shipped-in-v0-9-x) already skips *scoring* filtered-out vectors, but the pre-filter itself still runs `find()`, which materialises every matching document — embedding arrays included — just to collect their ids. An id-only execution path in the query executor (return ids without decoding document bodies) would cut the filter cost, especially for low-selectivity filters over large documents.

### HNSW on web and React Native

The `vector-hnsw` feature ships in `@taladb/node` since v0.8.3 but not in the WASM or JSI builds. Evaluate enabling it per platform: WASM bundle size, mobile memory ceilings, and graph build time on phone CPUs all need numbers first.

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
