---
title: Roadmap
description: Planned and in-progress features for TalaDB — query engine improvements, sync, developer tooling, and new platform targets.
---

# Roadmap

This page tracks planned and in-progress work for TalaDB. Items are grouped by theme and ordered roughly by priority within each group. The list is updated as the project evolves.

Have an idea or want to help prioritise? Open a [GitHub Discussion](https://github.com/thinkgrid-labs/taladb/discussions) or a feature request issue.

---

## In progress

### React Native — full iOS + Android TurboModule integration
The C FFI layer (`taladb-ffi`) and C++ JSI HostObject are complete. The remaining work is wiring the Xcode build phase (universal `.a` via `lipo`) and the Android Gradle AAR packaging so that `pod install` / Gradle are the only steps a consumer needs.

### `$or` index union across different fields
The query planner currently handles `$or` across multiple values of the **same** field (e.g. `role = 'admin' OR role = 'editor'`). The next step is merging results from **different** indexed fields (e.g. `status = 'pinned' OR priority = 1`) using a sorted-merge join on ULIDs.

### CLI interactive shell
`taladb shell <file>` — a REPL that accepts filter expressions in JSON, displays results as formatted tables, and supports tab-completion for collection and field names.

---

## Query engine

### Compound indexes
Index a tuple of fields `(lastName, firstName)` so that queries with equality on `lastName` and a range on `firstName` use a single B-tree scan instead of two separate index scans with an in-memory join.

### Aggregation pipeline
A lightweight `aggregate()` method supporting `$group`, `$sum`, `$avg`, `$min`, `$max`, `$count`, and `$sort` — enough to power dashboards and analytics views without moving data out of the database.

### Projection
`find(filter, { fields: ['name', 'email'] })` — return only specified fields, reducing deserialization cost for wide documents with many fields.

### Cursor / pagination
`find(filter, { skip: 0, limit: 20, sort: { createdAt: -1 } })` — stable, index-aware pagination without loading the entire result set into memory.

### `$regex` filter
Pattern matching against string fields using a compiled regex. Evaluated as a post-filter (no index support) but useful for search and validation.

### Nested field queries
Dot-notation access to nested object fields — `{ 'address.city': 'London' }` — without requiring the caller to flatten documents before inserting.

---

## Storage

### Write-ahead log compaction
redb already handles WAL compaction internally, but exposing a `db.compact()` API for explicit compaction (e.g. after bulk deletes) would let long-running applications reclaim disk space on demand.

### Pluggable serialisation
Allow the caller to swap `postcard` for `MessagePack` or `CBOR` via a `Codec` trait, making it easier to interoperate with databases or wire formats that already use those encodings.

### IndexedDB fallback backend
A complete `StorageBackend` implementation on top of IndexedDB for browsers that will never support OPFS (e.g. cross-origin iframes). Currently the fallback is in-memory only.

---

## Sync

### Conflict-free sync with CRDTs
A `CrdtSyncAdapter` that uses per-field logical clocks (LWW-register or grow-only sets) to merge concurrent writes from multiple devices without conflicts — suitable for collaborative offline-first apps.

### Sync over WebSockets
A reference sync server (`taladb-sync-server`) that accepts snapshot diffs over a WebSocket connection and applies `LastWriteWins` or CRDT merge logic server-side, enabling multi-device sync without a cloud database.

### Delta snapshots
Instead of exporting the full database on every sync, export only the records that changed since a given ULID watermark — reducing bandwidth for incremental sync scenarios.

---

## Developer experience

### `taladb generate` — TypeScript type generation
Inspect a live database and emit TypeScript interfaces for each collection, inferred from the stored documents. Useful for projects that don't start with a schema.

### `taladb studio` — local web UI
A browser-based GUI (served by `taladb-cli`) for browsing collections, running ad-hoc queries, inspecting indexes, and visualising query plans — similar to MongoDB Compass but for local files.

### React hooks package (`@taladb/react`)
First-party `useCollection`, `useWatch`, `useFind`, and `useFindOne` hooks that integrate with React's `useSyncExternalStore` for zero-tearing live query snapshots in concurrent React.

### Zod / Valibot schema validation
An optional `schema` option on `collection()` that validates documents with a Zod or Valibot schema before insert and after find, providing runtime type safety without a compile step.

### VS Code extension
Syntax highlighting for TalaDB filter expressions in JSON, inline document previews, and a collection browser panel in the VS Code sidebar.

---

## Platform

### Cloudflare Workers / Deno Deploy
A `StorageBackend` implementation backed by Cloudflare's `KV` or `Durable Objects` API, letting TalaDB run as the persistence layer inside an edge function with zero external dependencies.

### Bun native module
A Bun-native binding (using Bun's `bun:ffi`) that avoids the N-API layer for better startup performance and smaller binary size in Bun-first projects.

### Swift / Kotlin native packages
First-party Swift (`TalaDB.swift`) and Kotlin (`taladb-kotlin`) packages that wrap the C FFI layer directly, without React Native, for native iOS and Android apps that want an embedded document store.

### WASI target
Compile `taladb-core` to WASI (`wasm32-wasip1`) so it can run inside WASI runtimes (Wasmtime, WasmEdge, Fastly Compute) with filesystem access — bringing the same engine to server-side WASM environments.

---

## Security

### Key rotation
A `db.rekey(newKey)` method that re-encrypts all stored values in a single atomic transaction without requiring an export/import cycle.

### Field-level encryption
Encrypt individual fields rather than entire values, so that unencrypted fields can still be indexed and used in range queries while sensitive fields (e.g. `ssn`, `creditCard`) are protected at rest.

### Audit log
An append-only `_audit` collection that records every write operation (collection, document ID, operation type, timestamp) — opt-in, with configurable retention.
