---
title: Introduction
description: Learn what TalaDB is, how it works, and why it was built — the embedded database for local-first JavaScript apps, powered by a Rust core that runs in the browser, Node.js, and React Native.
---

# Introduction

## What is TalaDB?

Most JavaScript apps require three separate tools to handle structured queries, vector similarity search, and offline-first storage — each with its own API, each requiring a server. TalaDB replaces all three with a single **embedded database built in Rust** that runs entirely on the user's device, with no network dependency and no cloud subscription.

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

Packages are grouped by role, so it's clear at a glance what is the engine, what wraps it, and what consumes it:

```
taladb/
├── Cargo.toml                      # Rust workspace
├── pnpm-workspace.yaml
│
├── packages/
│   ├── core/                       # THE engine — pure Rust, no JS bindings (crate: taladb-core)
│   │   └── src/                    #   document/engine/index/collection/vector/query/…
│   │
│   ├── bindings/                   # Thin runtime WRAPPERS over core
│   │   ├── node/                   #   Node.js (napi-rs)          → @taladb/node
│   │   ├── web/                    #   Browser (wasm-bindgen+OPFS) → @taladb/web
│   │   └── react-native/           #   React Native (JSI + C FFI) → @taladb/react-native
│   │
│   ├── clients/                    # What apps import directly (pure TS)
│   │   ├── taladb/                 #   Unified meta-package        → taladb
│   │   └── react/                  #   React hooks                 → @taladb/react
│   │
│   ├── adapters/                   # Sync adapters (pure TS)
│   │   └── mongodb/                #   MongoDB bidirectional sync  → @taladb/sync-mongodb
│   │
│   ├── integrations/
│   │   └── cloudflare/             #   Cloudflare Workers deploy   → @taladb/cloudflare
│   │
│   └── tools/
│       └── cli/                    #   Dev CLI (crate: taladb-cli)
│
└── examples/
    ├── web-vite/                   # React + Vite demo
    ├── expo-app/                   # Expo React Native demo
    └── node-script/                # Node.js script demo
```

**core** is the engine; **bindings** are the runtime wrappers over it; **clients**, **adapters**, and **integrations** consume it. npm package names (right column) are unchanged by this layout — only their folders are grouped.

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

## TalaDB vs Recached

[Recached](https://recached.dev) is our sibling project at ThinkGrid Labs. They are deliberately complementary, not competing — the question is never "which one," it's "which layer."

| | TalaDB | Recached |
|---|---|---|
| What it is | Embedded **database** inside the app | Cache + **sync fabric** between backend and clients |
| Data model | Documents with MongoDB-like queries, indexes, ACID transactions | Keys — strings, collections, JSON |
| Superpower | On-device vector + hybrid search, rich queries | Multi-client sync: scoped auth, live fan-out, offline outbox, exactly-once delivery |
| Server | None — runs entirely on-device | The server is the product (Redis-compatible) |
| Truth model | **Device-local truth** | **Shared truth** across users and devices |

The one-line rule: **TalaDB is where one device's data lives; Recached is how many devices agree.** Reach for TalaDB when you need queryable structured data and semantic search on-device. Reach for Recached when many users or devices need to see the same live state.

They meet where an app needs both — locally queryable data that also syncs across users. TalaDB's [`SyncAdapter`](/roadmap) interface is designed to plug into a sync backbone, and Recached is a natural one: TalaDB owns the on-device query and vector engine, Recached owns the cross-device agreement.

## Status

TalaDB is production-ready. The Rust core, browser WASM, Node.js bindings, and React Native JSI layer are fully functional, tested, and stable across all supported platforms.

Try the [web demo](https://taladb-playground.vercel.app/) to see TalaDB running in the browser with OPFS persistence and on-device semantic search, or the [mobile demo](https://appetize.io/app/b_ugmjhjghdkgnjux4lzkepvsfma) to see it running on React Native. Follow the [GitHub repository](https://github.com/thinkgrid-labs/taladb) for progress updates.
