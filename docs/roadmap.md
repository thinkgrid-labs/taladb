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

### HTTP push sync 

**Future extensions** of this feature (not in scope for initial release):
- Native NoSQL adapters (`sync.adapter: mongodb | firestore | dynamodb`) with direct connection strings, removing the need for an intermediate API
- Bi-directional pull: `taladb sync --pull` fetches from the remote and merges locally
- Per-collection sync config (sync some collections, skip others)

### `taladb studio` — local web UI

A browser-based GUI (served by `taladb-cli`) for browsing collections, running ad-hoc queries, inspecting indexes, and visualising query plans — similar to MongoDB Compass but for local files.

### Zod / Valibot schema validation

An optional `schema` option on `collection()` that validates documents with a Zod or Valibot schema before insert and after find, providing runtime type safety without a compile step.

### `taladb generate` — TypeScript type generation

Inspect a live database and emit TypeScript interfaces for each collection, inferred from the stored documents. Useful for projects that don't start with a schema.

### VS Code extension

Syntax highlighting for TalaDB filter expressions in JSON, inline document previews, and a collection browser panel in the VS Code sidebar.

---

## 2 · Advanced sync

Multi-device and collaborative data sync beyond simple API push.

### Conflict-free sync with CRDTs

A `CrdtSyncAdapter` that uses per-field logical clocks (LWW-register or grow-only sets) to merge concurrent writes from multiple devices without conflicts — suitable for collaborative offline-first apps.

### Delta snapshots

Instead of exporting the full database on every sync, export only the records that changed since a given ULID watermark — reducing bandwidth for incremental sync scenarios. Foundation for the sync server below.

### Sync over WebSockets

A reference sync server (`taladb-sync-server`) that accepts snapshot diffs over a WebSocket connection and applies `LastWriteWins` or CRDT merge logic server-side, enabling multi-device sync without a cloud database.

---

## 3 · Storage

Internal improvements that improve efficiency and interoperability.

### Write-ahead log compaction

redb already handles WAL compaction internally, but exposing a `db.compact()` API for explicit compaction (e.g. after bulk deletes) would let long-running applications reclaim disk space on demand.

### Pluggable serialisation

Allow the caller to swap `postcard` for `MessagePack` or `CBOR` via a `Codec` trait, making it easier to interoperate with databases or wire formats that already use those encodings.

---

## 4 · Platform

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

## 5 · Security

Hardening for apps that handle sensitive data.

### Key rotation

A `db.rekey(newKey)` method that re-encrypts all stored values in a single atomic transaction without requiring an export/import cycle.

### Field-level encryption

Encrypt individual fields rather than entire values, so that unencrypted fields can still be indexed and used in range queries while sensitive fields (e.g. `ssn`, `creditCard`) are protected at rest.

### Audit log

An append-only `_audit` collection that records every write operation (collection, document ID, operation type, timestamp) — opt-in, with configurable retention.
