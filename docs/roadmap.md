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

**Future extensions** of this feature (not in scope for initial release):
- Native NoSQL adapters (`sync.adapter: mongodb | firestore | dynamodb`) with direct connection strings, removing the need for an intermediate API
- Bi-directional pull: `taladb sync --pull` fetches from the remote and merges locally
- Per-collection sync config (sync some collections, skip others)

### `taladb generate` — TypeScript type generation

Inspect a live database and emit TypeScript interfaces for each collection, inferred from the stored documents. Useful for projects that don't start with a schema.

### VS Code extension

Syntax highlighting for TalaDB filter expressions in JSON, inline document previews, and a collection browser panel in the VS Code sidebar.

---

## 2 · Advanced sync

### Sync over WebSockets

A reference sync server (`taladb-sync-server`) that accepts snapshot diffs over a WebSocket connection and applies `LastWriteWins` or CRDT merge logic server-side, enabling multi-device sync without a cloud database.

---

## 3 · Storage

Internal improvements that improve efficiency and interoperability.

### Pluggable serialisation

Allow the caller to swap `postcard` for `MessagePack` or `CBOR` via a `Codec` trait, making it easier to interoperate with databases or wire formats that already use those encodings.

---

## 4 · Platform

Expanding the runtimes TalaDB can target.

### Swift / Kotlin native packages

First-party Swift (`TalaDB.swift`) and Kotlin (`taladb-kotlin`) packages that wrap the C FFI layer directly, without React Native, for native iOS and Android apps that want an embedded document store.

### WASI target

Compile `taladb-core` to WASI (`wasm32-wasip1`) so it can run inside WASI runtimes (Wasmtime, WasmEdge, Fastly Compute) with filesystem access — bringing the same engine to server-side WASM environments.
