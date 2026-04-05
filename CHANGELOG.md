# Changelog

All notable changes to TalaDB will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-04-05

### Fixed
- **Sync correctness** — `LastWriteWins` adapter was using `Filter::Eq("_id", ...)` to look up existing documents, which never matched because `_id` is not a document field. Every sync operation incorrectly inserted duplicates instead of updating. Fixed by adding `find_by_id`, `delete_by_id`, and `insert_with_id` methods and routing sync through them.
- **Panic on corrupted storage keys** — vector search and snapshot parsing used `.unwrap()` on byte slice conversions after bounds checks. Replaced with proper error propagation (`InvalidSnapshot`) and graceful `continue` on malformed vector table keys.
- **Encryption stubs panicked instead of returning `Err`** — calling any encryption function without the `encryption` feature compiled in caused a `panic!`. Now returns `Err(TalaDbError::Encryption(...))` so callers can handle it.
- **Watch backpressure indistinguishable from disconnect** — `WatchRegistry::notify()` silently dropped slow subscribers. Added `TalaDbError::WatchBackpressure` variant; full-channel drops now log a warning and use the new variant, distinguishable from `WatchClosed` (channel disconnected).
- **Unnecessary `unwrap` in f32 vector decode** — `decode_f32_vec` used `c.try_into().unwrap()` inside `chunks_exact(4)`. Replaced with direct byte indexing `[c[0], c[1], c[2], c[3]]`.

### Improved
- **Index metadata cache** — `insert`, `update_one`, `update_many`, `delete_one`, `delete_many` previously loaded index metadata (regular, FTS, vector) from redb on every call (3 table scans per write). Metadata is now cached in a `Mutex<Option<CachedIndexes>>` on the `Collection` and invalidated only when indexes are created or dropped.
- **`IndexOr` query plan** — previously loaded full documents from each OR branch before deduplicating by ID. Now collects ULIDs first, deduplicates, then fetches documents once.
- **FTS `$contains` filter** — query string was tokenized once per document evaluated. Tokens are now computed once before the document loop.
- **Consistent error shapes across adapters** — WASM now returns `{error, code}` JSON objects; Node.js errors are prefixed with the variant name; React Native FFI exposes `taladb_last_error()` to retrieve the last error message from C/C++.
- **`apply_update` key allocations** — `$set`, `$push`, `$pull` operations now move field name strings instead of cloning them.

## [0.2.0] - 2026-04-05

### Added
- **Vector index (flat search)** — hybrid document + vector database support
  - `Collection::create_vector_index(field, dimensions, metric?)` — register a vector index on any numeric-array field; backfills existing documents automatically
  - `Collection::drop_vector_index(field)` — remove a vector index and all stored vectors
  - `Collection::find_nearest(field, query, top_k, pre_filter?)` — flat (brute-force) cosine / dot / euclidean similarity search; optional metadata pre-filter lets you combine regular NoSQL filtering with vector ranking in one call
  - `VectorMetric` enum: `Cosine` (default), `Dot`, `Euclidean`
  - `VectorSearchResult { document, score }` return type
  - Vector data stored in dedicated `vec::<collection>::<field>` redb tables (raw f32 LE bytes, keyed by ULID); kept in sync with insert / update / delete
  - Full bindings across all three runtimes: `@taladb/web` (WASM + SharedWorker), `@taladb/node` (napi-rs), `@taladb/react-native` (JSI)
  - TypeScript: `createVectorIndex`, `dropVectorIndex`, `findNearest` on `Collection<T>`; new exported types `VectorMetric`, `VectorIndexOptions`, `VectorSearchResult<T>`
  - New error variants: `VectorIndexNotFound`, `VectorDimensionMismatch`

## [0.1.2] - 2026-03-30

### Fixed
- CI: removed `publish-crates` job so GitHub Release is no longer blocked by crates.io

## [0.1.1] - 2026-03-30

### Fixed
- tsup build: mark `@taladb/web`, `@taladb/node`, `@taladb/react-native` as external to avoid bundle-time resolution errors
- clippy: `thread_local!` initializer made `const` in `document.rs`

## [0.1.0] - 2026-03-30

### Added
- Initial public release of TalaDB
- `taladb` — unified TypeScript package with platform auto-detection
- `@taladb/web` — browser WASM bindings via wasm-bindgen + OPFS SharedWorker
- `@taladb/node` — Node.js native module via napi-rs
- `@taladb/react-native` — full iOS + Android TurboModule integration via JSI HostObject; universal `.a` via `lipo` for iOS, Gradle AAR packaging for Android
- `taladb-core` — Rust core library published to crates.io
- `taladb-cli` — CLI tools (`inspect`, `export`, `import`, `count`, `drop`) published to crates.io
- MongoDB-like filter and update DSL (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$and`, `$or`, `$not`, `$contains`)
- `$or` index union across different indexed fields using sorted-merge join on ULIDs (e.g. `{ $or: [{ status: 'pinned' }, { priority: 1 }] }`)
- CLI interactive shell: `taladb shell <file>` — REPL with JSON filter expressions, formatted table output, and tab-completion for collection and field names
- Secondary B-tree indexes with automatic index selection
- ACID transactions backed by [redb](https://github.com/cberner/redb)
- Full-text search via inverted token index (`$contains`)
- Live query subscriptions (`collection.subscribe()`)
- Optional AES-GCM-256 encryption at rest (PBKDF2-HMAC-SHA256 key derivation)
- Versioned, atomic schema migrations
- Binary snapshot export / import
- SharedWorker + OPFS persistence for browsers; in-memory fallback for Safari iOS
- Comprehensive VitePress documentation site

[Unreleased]: https://github.com/thinkgrid-labs/taladb/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/thinkgrid-labs/taladb/releases/tag/v0.1.0
