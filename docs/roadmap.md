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

### ~~Write-ahead log compaction~~ ✓ Shipped in 0.7.3

`db.compact()` is now available on all platforms. It calls redb's built-in compaction and is exposed via the WASM worker (`compact` op), the Node.js napi binding, and the React Native C FFI (`taladb_compact`). Call it during idle periods after bulk deletes or tombstone pruning to reclaim disk space on demand.

### Pluggable serialisation

Allow the caller to swap `postcard` for `MessagePack` or `CBOR` via a `Codec` trait, making it easier to interoperate with databases or wire formats that already use those encodings.

---

## 4 · Platform

Expanding the runtimes TalaDB can target.

### ~~Cloudflare Workers~~ ✓ Shipped in 0.7.3

`@taladb/cloudflare` is now available. It runs TalaDB's existing WASM core (in-memory mode — no OPFS required) inside Cloudflare Workers Durable Objects. State is persisted as a binary snapshot in Durable Objects `storage.put()` between requests. The `TalaDBDurableObject` base class handles lazy init and snapshot restore. See the [Cloudflare guide](/guide/cloudflare) for usage.

### ~~Bun native module~~ ✓ Shipped in 0.7.3

`@taladb/node` now works on Bun out of the box via Bun's built-in N-API compatibility layer. No separate `bun:ffi` package is needed — install `@taladb/node` and use it identically to Node.js. Added Linux ARM64 (`aarch64-unknown-linux-gnu`) and Intel Mac (`x86_64-apple-darwin`) prebuilt targets alongside the existing ones.

### Swift / Kotlin native packages

First-party Swift (`TalaDB.swift`) and Kotlin (`taladb-kotlin`) packages that wrap the C FFI layer directly, without React Native, for native iOS and Android apps that want an embedded document store.

### WASI target

Compile `taladb-core` to WASI (`wasm32-wasip1`) so it can run inside WASI runtimes (Wasmtime, WasmEdge, Fastly Compute) with filesystem access — bringing the same engine to server-side WASM environments.

---

## 5 · Security

Hardening for apps that handle sensitive data.

### ~~Key rotation~~ ✓ Shipped in 0.7.2

`db.rekey(backend, old_key, new_key)` re-encrypts all stored values atomically. See the [encryption API](/api/encryption) for usage.

### ~~Field-level encryption~~ ✓ Shipped in 0.7.2

`Collection.with_field_encryption(fields, key)` encrypts individual fields with AES-GCM-256. Unencrypted fields remain fully indexable.

### ~~Audit log~~ ✓ Shipped in 0.7.2

`Collection.with_audit_log(caller)` writes an append-only `_audit` entry after every mutation. Read with `read_audit_log(backend, collection_filter, op_filter)`.
