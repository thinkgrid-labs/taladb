---
title: Benchmarks
description: TalaDB performance benchmarks — on-device document, query, and vector-search timings for the browser (WASM + OPFS) and Node.js (native), measured with the open-source suites in scripts/.
---

# Benchmarks

Real numbers, measured honestly. All results below come from the two benchmark suites that ship in the repository, so you can reproduce every row on your own hardware:

```bash
# Browser (WASM + OPFS — drives your installed Chrome headlessly)
pnpm --filter @taladb/web build
pnpm bench:web

# Node.js (native module)
pnpm --filter @taladb/node build
pnpm bench
```

## Setup

| | |
|---|---|
| TalaDB | v0.9.0, release builds |
| Machine | 2018 MacBook Pro — Intel i5-8259U @ 2.30 GHz, 8 GB RAM |
| Browser runtime | Chrome 150 headless · `@taladb/web` (WASM) · OPFS-backed |
| Node.js runtime | Node v22 · `@taladb/node` (napi) · file-backed database |
| Date | 2026-07-11 |

Latencies are the **median** of repeated timed iterations after warmup, with deterministic seeded data. Documents are realistic small records (~7 fields); vectors are 384-dimensional unit vectors — the output shape of `all-MiniLM-L6-v2`, the most common on-device embedding model. The browser suite drives the `@taladb/web` worker over its message protocol; the Node suite uses the raw N-API binding. In both cases that is the same path the `taladb` wrapper uses, so timings include everything an application pays.

This is deliberately modest hardware. On a recent Apple Silicon or desktop-class machine, expect meaningfully better numbers across the board.

# Browser — WASM + OPFS

The browser is TalaDB's flagship runtime: the same Rust engine compiled to WebAssembly, persisting to the Origin Private File System from a Web Worker. Every timing below includes the page ↔ worker `postMessage` round-trip and JSON serialisation — the full cost an app pays. Measured in real headless Chrome with OPFS active.

## Browser — document writes

The engine is memory-resident and persists a snapshot to OPFS on a short debounce, so writes are fast; see the durability note below for the trade-off.

| Operation | Detail | Result |
|---|---|---|
| `insert` (single doc) | one transaction per call | **~900 ops/s** |
| `insertMany` (batch 100) | single transaction per batch | **~27k docs/s** |
| `insertMany` (batch 1,000) | single transaction per batch | **~43k docs/s** |
| `insertMany` (batch 5,000) | bulk ingest of 100k docs | **~57k docs/s** |
| `updateOne` (by `_id`) | point update, `$set` one field | **~714 ops/s** |
| `deleteOne` (by `_id`) | point delete | **~667 ops/s** |

::: warning Browser durability model
Browser writes are fast because the engine is memory-resident and the worker persists a snapshot to OPFS on a **500 ms debounce** (plus a final flush on `close()` and before releasing the multi-tab lock). A hard crash of the browser process can lose the last ≤ 500 ms of writes. Node.js `fsync`s every committed transaction before the call returns — same API, stronger guarantee. This is the right trade-off for local-first browser apps; just don't read the two runtimes' write columns as identical durability.
:::

## Browser — query latency at 100,000 documents

| Operation | Detail | Result |
|---|---|---|
| `findOne` by `_id` | primary-key point get | **100 µs** |
| `find`, indexed equality | secondary index, ~10 matches | **300 µs** |
| `find`, indexed range (`$gte`) | newest ~100 docs | **800 µs** |
| `find`, unindexed field | full scan of 100k docs | **168 ms** |
| `count`, unindexed equality | scan, 12.5k matches | **175 ms** |

Sub-millisecond operations pay the worker `postMessage` round-trip (~50–100 µs), so browser point reads land around 100–300 µs — still far below anything network-bound. Scans are actually *faster* than Node's here because the memory-resident engine reads no disk pages.

## Browser — vector search (384-dim, cosine, top-10, flat)

Exact k-nearest-neighbour over all vectors — no approximation, no recall trade-off.

| Collection size | `findNearest` (median) |
|---|---|
| 1,000 vectors | **5.3 ms** |
| 10,000 vectors | **35 ms** |
| 50,000 vectors | **170 ms** |

| Operation | Detail | Result |
|---|---|---|
| `findNearest` + filter, 50k vectors | indexed pre-filter `locale: "en"` (10%), then rank | **162 ms** |
| Vector ingest, 50k vectors | `insertMany` with a live vector index | **~2.4k docs/s** |

Semantic search over a typical on-device corpus (1k–10k chunks) answers in **~35 ms or less** — faster than a network round-trip to any cloud vector database, with zero data leaving the device.

::: tip A SIMD build ~halves this
Browser vector search currently trails native by ~2× (Node does 50k in 93 ms; the browser 170 ms) — not the algorithm, the instruction set. The WASM build doesn't yet enable `simd128`, so the 384-wide dot product runs one lane at a time. An A/B `+simd128` build measured **50k at 81 ms and 10k at 17 ms** — near-native parity. Shipping it safely (dual builds with runtime feature detection, to keep Safari 15.2–16.3 working) is the top browser-performance item on the [roadmap](/roadmap#simd-dot-products-wasm-validated-native-next).
:::

# Node.js — native

The `@taladb/node` native module (napi), against a file-backed database — every committed write is `fsync`-durable when the call returns.

## Node.js — document writes

| Operation | Detail | Result |
|---|---|---|
| `insert` (single doc) | one transaction per call | **~48 ops/s** |
| `insertMany` (batch 100) | single transaction per batch | **~4.0k docs/s** |
| `insertMany` (batch 1,000) | single transaction per batch | **~19k docs/s** |
| `insertMany` (batch 5,000) | single transaction per batch | **~36k docs/s** |
| `updateOne` (by `_id`) | point update, `$set` one field | **~46 ops/s** |
| `deleteOne` (by `_id`) | point delete | **~46 ops/s** |

::: tip Batch your writes
Every individual write is a full ACID transaction — the ~48 ops/s ceiling for single-document calls is the cost of a durable `fsync` to disk, not of TalaDB's write path. The same machine sustains **36k docs/s** when writes share a transaction. If you are inserting more than a handful of documents, use `insertMany`.
:::

## Node.js — query latency at 100,000 documents

| Operation | Detail | Result |
|---|---|---|
| `findOne` by `_id` | primary-key point get | **25 µs** |
| `find`, indexed equality | secondary index, ~10 matches | **169 µs** |
| `find`, indexed range (`$gte`) | newest ~100 docs by `publishedAt` | **1.4 ms** |
| `find`, two-sided range (`$gte`+`$lt`) | ~100-doc `publishedAt` window | **1.4 ms** |
| `find`, unindexed field | full scan of 100k docs | **444 ms** |
| `count`, unindexed equality | scan, 12.5k matches | **470 ms** |

Point gets and indexed lookups stay in the microsecond range at 100k documents — the B-tree index layout gives `O(log n)` lookups regardless of collection size. Since v0.9.0 a **two-sided range is a single bounded index scan** (the ~100-doc window costs the same 1.4 ms as the one-sided form, down from ~463 ms in v0.8.x). Unindexed queries fall back to a full scan; if a field appears in your filters regularly, `createIndex` turns a 444 ms scan into a 169 µs lookup — a **~2,600×** difference.

## Node.js — vector search (384-dim, cosine, top-10)

The default (flat) index is exact k-NN over all vectors. The v0.9.0 scan rewrite (byte-streaming scoring, hoisted query norm, partial top-k selection) made it roughly **2× faster** than earlier releases:

| Collection size | `findNearest` (median) | v0.8.x |
|---|---|---|
| 1,000 vectors | **2.5 ms** | 4.0 ms |
| 10,000 vectors | **18 ms** | 40 ms |
| 50,000 vectors | **93 ms** | 188 ms |
| 100,000 vectors | **198 ms** | 369 ms |

Hybrid search — metadata pre-filter, then rank — is cheaper still, because filtered-out vectors are skipped before scoring when the filter field is indexed:

| Operation | Detail | Result |
|---|---|---|
| `findNearest` + filter, 100k vectors | indexed pre-filter matching 10% of docs, then rank | **346 ms** |
| Vector ingest, 100k vectors | `insertMany` with a live vector index | **~4.5k docs/s** |

::: tip Index your filter fields
The hybrid pre-filter is an ordinary document query, so it benefits from secondary indexes exactly like `find` does — index the field you filter on.
:::

### Optional HNSW index (Node.js, since 0.8.3)

For larger corpora, `@taladb/node` ships an approximate HNSW index (`createVectorIndex(field, { dimensions, indexType: 'hnsw' })`):

| Metric | 50,000 × 384-dim vectors |
|---|---|
| `findNearest` (HNSW) | **15 ms** (vs 93 ms flat — ~6× faster) |
| Graph build (one-off) | **~36 min** on this hardware (47 s at 10k) |
| recall@10, uniform random vectors | 41% — the adversarial worst case |
| recall@10, clustered vectors (embedding-like) | **100%** |

Read the recall rows carefully: uniform random vectors have no neighbourhood structure and are the known worst case for graph-based ANN. Real model embeddings are strongly clustered, where HNSW recall is excellent — but measure on *your* data before relying on it. Two operational caveats: the graph is built at `createVectorIndex` / `upgradeVectorIndex` time and is **not** updated by later writes (rebuild during idle periods after bulk ingests), and graph construction is CPU-intensive and superlinear — plan the one-off build cost. The flat index stays the right default for most on-device corpora; `@taladb/web` and React Native are currently flat-only.

## Reading these numbers

- **Scaling** — exact vector search is linear in collection size; document point lookups are logarithmic. Both behave predictably as your data grows.
- **Latency floor, not ceiling** — the test machine is a 2018 dual-fan ultrabook. Treat these as conservative.
- **Durability differs by platform** — the browser engine is memory-resident with a 500 ms debounced OPFS snapshot flush (see the note above); Node.js commits are `fsync`-durable per transaction. Same API, different persistence guarantee.
- **Browser vs native** — flat vector search is ~2× slower in WASM today purely for lack of `simd128`; a measured SIMD build closes the gap. Everything else is at parity or (for scans) faster in the browser.
- **React Native** — the same Rust core runs on React Native via JSI with a file-backed database like Node.js; a runtime-specific suite is planned.
- **Methodology** — deterministic seeded data, warmup before measurement, medians reported, one process at a time on an otherwise idle machine. Read [`scripts/bench-web.mjs`](https://github.com/thinkgrid-labs/taladb/blob/main/scripts/bench-web.mjs) + [`scripts/bench-web/bench.browser.js`](https://github.com/thinkgrid-labs/taladb/blob/main/scripts/bench-web/bench.browser.js) (browser) and [`scripts/bench.mjs`](https://github.com/thinkgrid-labs/taladb/blob/main/scripts/bench.mjs) (Node) for the exact workloads.
