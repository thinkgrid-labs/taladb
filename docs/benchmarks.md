---
title: Benchmarks
description: TalaDB performance benchmarks — document write throughput, indexed query latency, and on-device vector search timings for Node.js (native) and the browser (WASM + OPFS), measured with the open-source suites in scripts/.
---

# Benchmarks

Real numbers, measured honestly. All results below come from the two benchmark suites that ship in the repository, so you can reproduce every row on your own hardware:

```bash
# Node.js (native module)
pnpm --filter @taladb/node build
pnpm bench

# Browser (WASM + OPFS — drives your installed Chrome headlessly)
pnpm --filter @taladb/web build
pnpm bench:web
```

## Setup

| | |
|---|---|
| TalaDB | v0.8.3, release builds |
| Machine | 2018 MacBook Pro — Intel i5-8259U @ 2.30 GHz, 8 GB RAM |
| Node.js runtime | Node v22 · `@taladb/node` (napi) · file-backed database |
| Browser runtime | Chrome 149 headless · `@taladb/web` (WASM) · OPFS-backed |
| Date | 2026-07-09 |

Latencies are the **median** of repeated timed iterations after warmup, with deterministic seeded data. Documents are realistic small records (~7 fields); vectors are 384-dimensional unit vectors — the output shape of `all-MiniLM-L6-v2`, the most common on-device embedding model. The Node suite uses the raw N-API binding; the browser suite drives the `@taladb/web` worker over its message protocol. In both cases that is the same path the `taladb` wrapper uses, so timings include everything an application pays.

This is deliberately modest hardware. On a recent Apple Silicon or desktop-class machine, expect meaningfully better numbers across the board.

## Node.js — document writes

File-backed, every operation durable on disk when the call returns.

| Operation | Detail | Result |
|---|---|---|
| `insert` (single doc) | one transaction per call | **~47 ops/s** |
| `insertMany` (batch 100) | single transaction per batch | **~3.9k docs/s** |
| `insertMany` (batch 1,000) | single transaction per batch | **~19k docs/s** |
| `insertMany` (batch 5,000) | single transaction per batch | **~34k docs/s** |
| `updateOne` (by `_id`) | point update, `$set` one field | **~47 ops/s** |
| `deleteOne` (by `_id`) | point delete | **~46 ops/s** |

::: tip Batch your writes
Every individual write is a full ACID transaction — the ~47 ops/s ceiling for single-document calls is the cost of a durable commit to disk (redb `fsync`), not of TalaDB's write path. The same machine sustains **34k docs/s** when writes share a transaction. If you are inserting more than a handful of documents, use `insertMany`.
:::

## Node.js — query latency at 100,000 documents

| Operation | Detail | Result |
|---|---|---|
| `findOne` by `_id` | primary-key point get | **23 µs** |
| `find`, indexed equality | secondary index, ~10 matches | **167 µs** |
| `find`, indexed range (`$gte`) | newest ~100 docs by `publishedAt` | **1.4 ms** |
| `find`, unindexed field | full scan of 100k docs | **434 ms** |
| `count`, unindexed equality | scan, 12.5k matches | **461 ms** |

Point gets and indexed lookups stay in the microsecond range at 100k documents — the B-tree index layout gives `O(log n)` lookups regardless of collection size. Unindexed queries fall back to a full collection scan; if a field appears in your filters regularly, `createIndex` turns a 434 ms scan into a 167 µs lookup — a **~2,600×** difference.

::: warning Two-sided ranges
The query planner is currently greedy rather than cost-based: a two-sided range (`$gte` + `$lt` on the same field) uses the index for the lower bound only and post-filters the rest, so it can scan far more index entries than the window contains (~449 ms for a ~100-doc window at 100k docs, versus 1.4 ms for the one-sided form). Bounded range plans are on the roadmap. Until then, prefer one-sided ranges on recent data, or an indexed equality alongside the range.
:::

## Node.js — vector search (384-dim, cosine, top-10)

The default (flat) index is exact k-nearest-neighbour over all vectors — no approximation, no recall trade-off.

| Collection size | `findNearest` (median) |
|---|---|
| 1,000 vectors | **4.0 ms** |
| 10,000 vectors | **38 ms** |
| 50,000 vectors | **188 ms** |
| 100,000 vectors | **387 ms** |

Hybrid search — metadata pre-filter, then rank — costs roughly the same as pure vector search when the filter field is indexed:

| Operation | Detail | Result |
|---|---|---|
| `findNearest` + filter, 100k vectors | indexed pre-filter matching 10% of docs, then rank | **428 ms** |
| Vector ingest, 100k vectors | `insertMany` with a live vector index | **~4.1k docs/s** |

::: tip Index your filter fields
The hybrid pre-filter is an ordinary document query, so it benefits from secondary indexes exactly like `find` does. In this suite, indexing the filter field brought filtered search from ~3 s down to 428 ms at 100k vectors.
:::

For context: a typical on-device semantic search corpus (notes app, offline docs, chat history) is 1k–10k chunks, where exact search answers in **under 40 ms** — faster than a network round-trip to any cloud vector database, with zero data leaving the device.

## Browser — WASM + OPFS (Chrome headless)

The same operations, measured against the `@taladb/web` worker in a real Chrome instance with OPFS active. Every timing includes the page ↔ worker `postMessage` round-trip and JSON serialisation.

### Document writes

| Operation | Detail | Result |
|---|---|---|
| `insert` (single doc) | one transaction per call | **~1.0k ops/s** |
| `insertMany` (batch 100) | single transaction per batch | **~26k docs/s** |
| `insertMany` (batch 1,000) | single transaction per batch | **~43k docs/s** |
| `insertMany` (batch 5,000) | single transaction per batch | **~57k docs/s** |
| `updateOne` (by `_id`) | point update, `$set` one field | **~625 ops/s** |
| `deleteOne` (by `_id`) | point delete | **~714 ops/s** |

::: warning Different durability model
Browser writes are much faster than Node's single-write numbers because the durability guarantee is different. In the browser the engine is memory-resident and the worker persists a snapshot to OPFS on a **500 ms debounce** (plus a final flush on `close()` and before releasing the multi-tab lock). A hard crash of the browser process can lose the last ≤ 500 ms of writes. On Node.js every committed transaction is `fsync`ed before the call returns. This is the right trade-off for local-first browser apps — but don't read these two write columns as the same guarantee.
:::

### Query latency at 100,000 documents

| Operation | Detail | Browser | Node.js |
|---|---|---|---|
| `findOne` by `_id` | primary-key point get | **100 µs** | 23 µs |
| `find`, indexed equality | secondary index, ~10 matches | **300 µs** | 167 µs |
| `find`, indexed range (`$gte`) | newest ~100 docs | **800 µs** | 1.4 ms |
| `find`, unindexed field | full scan of 100k docs | **157 ms** | 434 ms |
| `count`, unindexed equality | scan, 12.5k matches | **166 ms** | 461 ms |

Sub-millisecond operations pay the worker `postMessage` round-trip (~50–100 µs), so browser point reads land around 100–300 µs — still far below anything network-bound. Scans are actually *faster* in the browser because the memory-resident engine reads no disk pages.

### Vector search (384-dim, cosine, top-10, flat)

| Collection size | `findNearest` (median) | Node.js |
|---|---|---|
| 1,000 vectors | **5.3 ms** | 4.0 ms |
| 10,000 vectors | **35 ms** | 38 ms |
| 50,000 vectors | **171 ms** | 188 ms |

| Operation | Detail | Result |
|---|---|---|
| `findNearest` + filter, 50k vectors | indexed pre-filter matching 10%, then rank | **159 ms** |
| Vector ingest, 50k vectors | `insertMany` with a live vector index | **~2.3k docs/s** |

WASM vector search runs at parity with the native module — the scan is pure Rust arithmetic in both builds, and semantic search over a typical 1k–10k chunk corpus stays **under 40 ms** in the browser too.

## Reading these numbers

- **Scaling** — exact vector search is linear in collection size; document point lookups are logarithmic. Both behave predictably as your data grows.
- **Latency floor, not ceiling** — the test machine is a 2018 dual-fan ultrabook. Treat these as conservative.
- **Durability differs by platform** — Node.js commits are `fsync`-durable per transaction; the browser engine is memory-resident with a 500 ms debounced OPFS snapshot flush (see the note above). Same API, different persistence guarantee.
- **React Native** — the same Rust core runs on React Native via JSI with a file-backed database like Node.js; a runtime-specific suite is planned.
- **Methodology** — deterministic seeded data, warmup before measurement, medians reported, one process at a time on an otherwise idle machine. Read [`scripts/bench.mjs`](https://github.com/thinkgrid-labs/taladb/blob/main/scripts/bench.mjs) (Node) and [`scripts/bench-web.mjs`](https://github.com/thinkgrid-labs/taladb/blob/main/scripts/bench-web.mjs) + [`scripts/bench-web/bench.browser.js`](https://github.com/thinkgrid-labs/taladb/blob/main/scripts/bench-web/bench.browser.js) (browser) for the exact workloads.
