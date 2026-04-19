---
title: Introduction
description: Learn what TalaDB is, how it works, and why it was built — the embedded database for local-first JavaScript apps, powered by a Rust core that runs in the browser, Node.js, and React Native.
---

# Introduction

## What is TalaDB?

TalaDB is an open-source, **local-first document and vector database** built in Rust and designed for the modern JavaScript ecosystem. It lets React and React Native developers store and query structured data — and search vector embeddings — directly on the user's device, with no server, no network dependency, and no cloud subscription.

Data is stored as schemaless JSON-like documents organised into named **collections**. Queries use a MongoDB-inspired filter DSL. Vector indexes sit alongside regular document fields: a single `findNearest` call can rank by embedding similarity while filtering by metadata, giving you the hybrid search pattern that cloud vector databases charge for, running entirely on-device.

As local AI inference becomes mainstream (transformers.js, ONNX Web, WebGPU), applications generate embeddings on the client and need somewhere to store and search them. TalaDB is that place.

The same Rust core powers every runtime:

| Runtime | Package | Mechanism |
|---|---|---|
| Browser | `@taladb/web` | `wasm-bindgen` + OPFS |
| Node.js | `@taladb/node` | `napi-rs` native module |
| React Native | `@taladb/react-native` | JSI HostObject (C FFI) |

All three surfaces expose a single unified TypeScript API from the `taladb` package, so application code never needs to branch on platform.

## Architecture overview

TalaDB is built in three layers:

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 3 — TypeScript / JavaScript API                        │
│  wasm-bindgen (browser) · napi-rs (Node.js) · JSI (RN)       │
└──────────────────────────────┬───────────────────────────────┘
                               │  postcard bytes
┌──────────────────────────────▼───────────────────────────────┐
│  Layer 2 — Document + Vector Engine  (taladb-core)            │
│  Document model · B-tree indexes · Vector indexes             │
│  Query planner/executor · FTS · Migrations · Live queries     │
└──────────────────────────────┬───────────────────────────────┘
                               │  raw key/value bytes
┌──────────────────────────────▼───────────────────────────────┐
│  Layer 1 — KV Storage Engine                                  │
│  redb (native / Node.js) · OPFS backend (browser)            │
└──────────────────────────────────────────────────────────────┘
```

**Layer 1 — Storage.** [redb](https://github.com/cberner/redb) is a pure-Rust, B-tree embedded key-value store. In the browser, TalaDB replaces it with a custom OPFS backend that uses `FileSystemSyncAccessHandle` inside a SharedWorker, giving durable on-device persistence without IndexedDB's overhead.

**Layer 2 — Document + vector engine.** `taladb-core` sits above the storage layer and knows nothing about JavaScript bindings. It provides the document model, secondary index key encoding, vector index storage and similarity search, the filter/update AST, the query planner, full-text search, and schema migrations. Documents and vector entries live in separate redb tables (`docs::`, `idx::`, `vec::`) but are updated atomically in the same transaction.

**Layer 3 — Bindings.** Thin platform-specific wrappers translate JavaScript values into the Rust types that `taladb-core` expects and route them through the storage layer.

## Repository structure

```
taladb/
├── Cargo.toml                      # Rust workspace
├── pnpm-workspace.yaml
│
├── packages/
│   ├── taladb-core/                # Pure Rust core — no JS bindings
│   │   └── src/
│   │       ├── document.rs         # Value enum, Document struct (ULID IDs)
│   │       ├── engine.rs           # StorageBackend trait + redb implementation
│   │       ├── index.rs            # Secondary index key encoding
│   │       ├── collection.rs       # CRUD + vector index operations
│   │       ├── vector.rs           # Vector index, similarity math, encoding
│   │       ├── migration.rs        # Schema versioning
│   │       ├── crypto.rs           # AES-GCM-256 encryption wrapper
│   │       ├── watch.rs            # Live query subscriptions
│   │       └── query/
│   │           ├── filter.rs       # Filter AST
│   │           ├── planner.rs      # Index selection
│   │           └── executor.rs     # Scan + post-filter
│   │
│   ├── @taladb/web/                # Browser (wasm-bindgen + OPFS)
│   ├── @taladb/node/                # Node.js (napi-rs native module)
│   ├── @taladb/react-native/        # React Native (JSI HostObject + C FFI)
│   └── taladb/                     # Unified TypeScript package
│
└── examples/
    ├── web-vite/                   # React + Vite demo
    ├── expo-app/                   # Expo React Native demo
    └── node-script/                # Node.js script demo
```

## Packages

TalaDB is published as four focused npm packages:

| Package | Purpose |
|---------|---------|
| `taladb` | Unified TypeScript API — auto-detects the platform and delegates to the right backend |
| `@taladb/web` | Browser WASM + OPFS backend |
| `@taladb/node` | Node.js napi-rs native module |
| `@taladb/react-native` | React Native JSI TurboModule |

### Which packages do I install?

**Browser (Vite, Next.js, etc.)**
```bash
pnpm add taladb @taladb/web
```

**Node.js**
```bash
pnpm add taladb @taladb/node
```

**React Native — shared codebase with web or Node.js**
```bash
pnpm add taladb @taladb/react-native
```
Use `openDB` from `taladb` everywhere. It detects React Native automatically.

**React Native — standalone app (RN only, no shared code)**
```bash
pnpm add @taladb/react-native
```
Import directly from `@taladb/react-native`. Calls are synchronous via JSI — no `await` needed. See the [React Native guide](/guide/react-native#standalone-installation) for details.

The `taladb` package lists the platform packages as `optionalDependencies`, which means npm/pnpm won't fail the install if one isn't present — but it won't install them automatically either. You must add whichever platform package you need alongside `taladb`.

## Status

TalaDB is production-ready. The Rust core, browser WASM, Node.js bindings, and React Native JSI layer are fully functional, tested, and stable across all supported platforms.

Try the [web demo](https://taladb-playground.vercel.app/) to see TalaDB running in the browser with OPFS persistence and on-device semantic search, or the [mobile demo](https://appetize.io/app/b_ugmjhjghdkgnjux4lzkepvsfma) to see it running on React Native. Follow the [GitHub repository](https://github.com/thinkgrid-labs/taladb) for progress updates.
