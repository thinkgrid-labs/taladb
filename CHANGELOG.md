# Changelog

All notable changes to TalaDB will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-04-12

### Added
- **HTTP push sync** — event-driven, webhook-style sync that pushes mutation events from the database to a remote server over HTTP:
  - `taladb.config.json` / `taladb.config.ts` support — configure `sync.pushEndpoint`, `sync.authToken`, and `sync.retryPolicy` per project
  - `SyncHook` trait implementation — every `insert`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany` emits a typed `SyncEvent` to a background dispatcher
  - **Browser / WASM** — `SyncConfig` wired into the WASM worker; mutations are dispatched from `worker_db.rs` via `fetch()` on the worker thread; no main-thread blocking
  - **Node.js** — `loadConfig` / `validateConfig` read the project config file at startup and wire the sync hook into the native module
  - **React Native** — `TalaDBModule.initialize({ pushEndpoint, authToken })` passes sync config to the JSI layer at runtime; no config file needed
  - Configurable retry policy: exponential back-off with jitter, configurable `maxRetries` and `initialDelayMs`
  - `SyncEvent` payload includes `collection`, `operation`, `documentId`, `timestamp`, and the full document diff
  - CLI: `taladb sync status` shows pending event queue depth and last-push timestamp

### Fixed
- **Android `TalaDBModule` — wrong library loaded** — `System.loadLibrary("taladb_ffi")` loaded the raw Rust crate which has no JNI entrypoints; corrected to load `taladb_ffi` then `taladb_jsi`
- **Android `TalaDBModule` — wrong JSI runtime pointer** — `jsCallInvokerHolder.nativeCallInvoker` returns a `CallInvoker*`, not a `jsi::Runtime*`; fixed to `reactContext.javaScriptContextHolder!!.get()`
- **iOS podspec — static library replaced with XCFramework** — `s.vendored_libraries = "libtaladb_ffi.a"` replaced with `s.vendored_frameworks = "TalaDBFfi.xcframework"` to support both device and Apple Silicon simulator slices; CI now builds three targets (`aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`) and packages them via `xcodebuild -create-xcframework`
- **Clippy: wasm32-only imports in `worker_db.rs`** — `HashMap`, `Arc`, `SyncEvent`, `SyncHook`, and related types were declared at crate level but only used inside `#[cfg(target_arch = "wasm32")]` blocks; moved behind matching `#[cfg]` guards to fix unused-import warnings in the CI `--target x86_64-unknown-linux-gnu` check
- **Browser bundle — `js-yaml` import error** — `taladb`'s `config.ts` pulled in `js-yaml`, `node:fs`, and `node:path`; Vite statically analysed these even behind runtime guards and threw at startup. Fixed with a separate browser build entry (`index.browser.mjs`) that substitutes a no-op `config.browser.ts` stub via an esbuild plugin; the `browser` export condition in `package.json` ensures Vite resolves this path automatically
- **Playground `browser` export condition not applied** — `dev-playground.sh` copied `dist/` but not `package.json`, so the playground's `node_modules/taladb` still resolved `index.mjs` (the Node build) instead of `index.browser.mjs`; fixed by also copying `package.json`

### Improved
- **`web.md` browser support table** — updated to reflect the actual DedicatedWorker + Web Locks architecture: OPFS is the primary fast path; IndexedDB snapshot fallback activates immediately via `{ ifAvailable: true }` (no blocking wait); secondary tabs are live-synced via `BroadcastChannel`
- **`react-native.md`** — HTTP push sync section added; removed stale "not yet published to npm" limitation (package is live at `@taladb/react-native@0.5.0`); dropped `x86` ABI from Android build matrix (no current-generation device or emulator requires it)
- **Android NDK version pinned** — CI now installs NDK `27.2.12479018` explicitly via `setup-android`

## [0.5.0] - 2026-04-12

### Added
- **`@taladb/react` — React hooks package** — first-party hooks for live-updating queries in React and React Native:
  - `TalaDBProvider` / `useTalaDB` — context provider for the `TalaDB` instance
  - `useCollection<T>(name)` — returns a stable, memoised `Collection<T>` from context; safe to pass directly to `useFind` / `useFindOne` without wrapping in `useMemo`
  - `useFind<T>(collection, filter?)` — subscribes to a live query; returns `{ data: T[], loading: boolean }` and re-renders automatically on every matching write
  - `useFindOne<T>(collection, filter)` — same as `useFind` but returns the first matching document (`data: T | null`)
  - All hooks are backed by `useSyncExternalStore` for zero-tearing snapshots in concurrent React
  - Inline filter objects (e.g. `{ active: true }`) are serialised to a string key internally — no re-subscription on every render
  - Works in React (browser + Node.js) and React Native with identical API; no platform-specific code required
  - Full TypeScript generics — `data` is correctly typed as `T[]` / `T | null` from the document interface
  - Install: `pnpm add taladb @taladb/web @taladb/react` (browser) or `pnpm add taladb @taladb/react-native @taladb/react` (React Native)

### Infrastructure
- CI `ts-check` job now type-checks `@taladb/react` alongside `taladb`
- CI `build-taladb-react` job runs unit + integration tests (52 cases) then builds and verifies `dist/` before publish
- Release workflow publishes `@taladb/react` to npm as part of the standard release pipeline

## [0.4.0] - 2026-04-11

### Added
- **Full-text search index** — `collection.createFtsIndex(field)` builds an inverted token index on any string field. `$contains` queries now use a `FtsScan` plan (O(1) token lookup) instead of a `FullScan` (O(n) document scan). Drop with `dropFtsIndex(field)`. Backfills existing documents on creation.
- **HNSW vector index** — `createVectorIndex(field, { indexType: 'hnsw', hnswM?, hnswEfConstruction? })` builds a Hierarchical Navigable Small World graph for approximate nearest-neighbour search. Significantly faster than flat brute-force on large collections. Upgrade an existing flat index in-place with `upgradeVectorIndex(field)`. Available on Node.js and React Native; browser WASM now throws a clear error (requires native threads via `rayon`).
- **`listIndexes()` API** — `await collection.listIndexes()` returns `{ btree: string[], fts: string[], vector: string[] }` describing every index currently on the collection. Available on all three runtimes.
- **Query planner plans** — the query engine now selects from four execution strategies: `FullScan` (no usable index), `IndexScan` (B-tree, O(log n)), `FtsScan` (inverted FTS index, O(1)), and `IndexOr` (sorted-merge union of index scans, zero duplicates).

### Fixed
- **`createFtsIndex` idempotency** — previously returned `Err(IndexExists)` when called on a collection that already had the index. Now returns `Ok(())` (no-op), matching the behaviour of `createIndex` and `createVectorIndex`.
- **`$contains` missing from WASM filter parsers** — the `$contains` operator was not handled in `worker_db.rs` or `lib.rs`, causing every `find({ field: { $contains: ... } })` call in the browser to return `Error: invalid filter`. Added to both parsers.
- **`Update` enum missing `Clone` derive** — `updateMany` called `update.clone()` internally but `Update` did not derive `Clone`, causing a compile error surfaced by a full incremental rebuild. Fixed with `#[derive(Clone)]`.
- **Multi-tab OPFS deadlock** — a second browser tab would block indefinitely waiting for the OPFS Web Lock held by the first tab. Fixed with `{ ifAvailable: true }` — the second tab now falls back to an IndexedDB-backed in-memory database immediately and stays live-synced via `BroadcastChannel`.

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

[Unreleased]: https://github.com/thinkgrid-labs/taladb/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.2.1...v0.4.0
[0.2.1]: https://github.com/thinkgrid-labs/taladb/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/thinkgrid-labs/taladb/releases/tag/v0.1.0
