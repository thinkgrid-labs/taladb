# Changelog

All notable changes to TalaDB will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.3] - 2026-04-18

### Added

- **`db.compact()`** — on-demand WAL compaction, exposed across every platform layer. Call during idle periods after bulk deletes or tombstone pruning to reclaim disk space.
  - **`taladb-core`** — `StorageBackend::compact()` default no-op + `RedbBackend` implementation calling `redb::Database::compact()`. `Database::compact()` public method re-exported from the crate root. `Arc<Mutex<Database>>` wrapping ensures safe `&mut self` access without holding the lock across transaction lifetimes.
  - **`@taladb/web`** — `WorkerDB.compact()` wasm-bindgen method; `'compact'` op dispatched in the SharedWorker. OPFS-specific imports (`FileSystemSyncAccessHandle`, `openWithOpfs`, `openWithConfigAndOpfs`) gated behind new `cf-workers` Cargo feature so the Cloudflare Workers WASM build is free of browser-only web-sys bindings.
  - **`@taladb/node`** — `TalaDBNode.compact()` napi binding.
  - **`@taladb/react-native`** — `taladb_compact(handle)` C FFI function; `"compact"` property dispatched from `TalaDBHostObject`; declared in `taladb.h`.
  - **`taladb`** — `compact(): Promise<void>` added to the `TalaDB` interface and wired in all four adapter return objects (browser worker, Node.js, React Native, in-memory fallback).

- **`@taladb/cloudflare`** — new package: TalaDB adapter for Cloudflare Workers Durable Objects.
  - Runs the existing `@taladb/web` WASM core in in-memory mode (no OPFS required); state is persisted as a binary snapshot via Durable Objects `storage.put('__taladb_snapshot__')` between requests.
  - `openDurableDB(storage)` — open a TalaDB-compatible database from `this.ctx.storage`; restores from the last saved snapshot on cold-start / hibernation wake-up.
  - `CloudflareDB` — full TalaDB-compatible handle with `collection()`, `flush()`, `compact()`, and `close()`.
  - `TalaDBDurableObject` — base class; extend and export from your Worker. Provides `getDB()` (lazy init, cached for isolate lifetime) and a default `fetch()` override point.
  - `createVectorIndex` throws a clear error when `indexType === 'hnsw'` (requires native threads unavailable in Workers).
  - Full TypeScript declarations (`index.d.ts`).

- **Bun native module support** — `@taladb/node` now works on Bun out of the box via Bun's built-in N-API compatibility layer. No separate `bun:ffi` package needed — install `@taladb/node` and use it identically to Node.js. Added `"bun": ">=1.0"` to `engines`. Added Linux ARM64 (`aarch64-unknown-linux-gnu`) and Intel Mac (`x86_64-apple-darwin`) prebuilt targets alongside the existing ones.

- **`taladb studio` — local web UI** — new `taladb studio <file>` CLI command that starts a local HTTP server and opens a browser-based database explorer.
  - Collections listed in the sidebar with live document counts.
  - Paginated document table (50 per page) with dynamic column detection across all unique fields in the current page.
  - Client-side search bar — filters the current page by full-document JSON substring match with no round-trip.
  - Click any row to open a detail panel showing the full pretty-printed document JSON.
  - Delete documents from the row action or the detail panel (with confirmation).
  - `--port <n>` (default `4321`) and `--no-open` flags.
  - Built with `tiny_http` (sync, no Tokio runtime) and a single embedded HTML file — no external assets, no bundler. The binary is fully self-contained.

- **Zod / Valibot schema validation** — optional runtime type safety for `Collection<T>`. Pass a `schema` option to `db.collection()` to validate documents before insert.
  - Compatible with Zod (`z.object(…)`), Valibot, or any object with `parse(data: unknown): T`.
  - Validates on `insert` and `insertMany`; optionally on `find` / `findOne` via `validateOnRead: true`.
  - Throws `TalaDbValidationError` (exported from `taladb`) with the context label (`insert`, `insertMany[2]`) and the original schema library error as `cause`.
  - Collections without a `schema` option are unchanged — zero overhead.
  - `@taladb/cloudflare` exposes the same `schema` option and exports its own `TalaDbValidationError`.

[0.7.3]: https://github.com/thinkgrid-labs/taladb/compare/v0.7.2...v0.7.3

## [Unreleased] — 0.7.2

### Added

- **`rekey(backend, old_key, new_key)`** (`encryption` feature) — rotate the AES-GCM-256 encryption key on a live database without a full export/import cycle. Iterates every table in the raw backend, decrypts each value with `old_key`, and re-encrypts with `new_key` in an atomic transaction per table. Returns the count of re-encrypted values. Passing the wrong `old_key` fails immediately with `TalaDbError::Encryption`. Re-exported from the crate root as `taladb_core::rekey`.

- **`Collection::with_field_encryption(fields, key)`** (`encryption` feature) — per-field AES-GCM-256 encryption. Listed field values are encrypted before storage (using `field:<name>` as AAD so ciphertexts cannot be transplanted between fields) and decrypted transparently on all read paths (`find`, `find_with_options`, `find_one`). All other fields remain in plaintext and fully indexable. Encrypted fields are stored as `Value::Bytes` and cannot be queried by value.

- **`Collection::with_audit_log(caller)`** — opt-in append-only audit log. After every successful mutation (`insert`, `insert_many`, `update_one`, `update_many`, `delete_one`, `delete_many`) an entry is written to the `_audit` table containing: `collection`, `op` (`"insert"` | `"update"` | `"delete"`), `doc_id`, `ts` (ms since Unix epoch), and the `caller` identity string supplied by the application. No update or delete API exists for audit records. Read with `taladb_core::read_audit_log(backend, collection_filter, op_filter)`.

- **`read_audit_log(backend, collection_filter, op_filter)`** — scan the `_audit` table and return `Vec<AuditEntry>`, optionally filtered by collection name and/or operation type. Returns entries in ULID insertion order.

- **`AuditEntry`**, **`AuditOp`** — public types for working with audit log entries, re-exported from the crate root.

## [Unreleased] — 0.7.1

### Added

- **Query timeouts** — `FindOptions` has a new optional `timeout: Option<std::time::Duration>` field. When set, `find_with_options` checks elapsed time between candidate documents and returns `Err(TalaDbError::QueryTimeout)` if the deadline is exceeded. No-op when `None` (default). Bindings for WASM, Node.js, and React Native surface this as a `"QueryTimeout"` error code.

- **`TalaDbError::QueryTimeout` variant** — new error variant returned when a query exceeds its configured timeout.

- **`tracing` spans on heavy operations** — `Collection::find`, `Collection::find_with_options`, `Collection::find_nearest`, and `Database::export_snapshot` are now annotated with `#[tracing::instrument]`. Operators using an OpenTelemetry or Jaeger subscriber will see per-call spans with `collection` and `top_k` fields automatically.

- **Fuzz targets** (`packages/taladb-core/fuzz/`) — two `cargo-fuzz` targets added:
  - `fuzz_snapshot`: feeds arbitrary bytes into `Database::restore_from_snapshot` to catch panics in the snapshot parser.
  - `fuzz_filter`: deserializes arbitrary bytes as `Document` and runs filter evaluation, catching deserialization and matching panics.
    Run with `cargo fuzz run fuzz_snapshot` from `packages/taladb-core/`.

## [Unreleased] — 0.7.0

### Breaking Changes

- **`Database::collection()` now returns `Result<Collection, TalaDbError>`** instead of `Collection`. Call sites must handle the error with `?` (in functions returning `Result`) or `.unwrap()` (in tests). Returns `TalaDbError::InvalidName` if the name is empty, longer than 128 characters, or contains `"::"`.

- **Encrypted data format v0 is unreadable by `>= 0.6.2`**. Any database encrypted before `0.6.2` (without the version byte and AAD binding) must be migrated with the new `migrate_encrypted_v0_to_v1` helper before the upgrade can be completed.

### Added

- **`migrate_encrypted_v0_to_v1(backend, key)`** — one-time migration helper for databases encrypted before `0.6.2`. Reads every stored value using the old format (`[12-byte nonce][ciphertext]`, no AAD), re-encrypts it with the current v1 format (version byte + AAD binding), and writes the result back atomically per table. Returns the count of values re-encrypted. Requires the `encryption` feature.

- **Collection name validation at handle construction** — `Database::collection()` now validates the name eagerly (empty, >128 chars, contains `"::"`), surfacing errors at handle creation time rather than silently at index creation time. Also adds a 128-character maximum length check.

- **`tracing` crate integration** — all internal `eprintln!` calls replaced with structured `tracing::warn!` / `tracing::error!` calls. Operators can now route TalaDB diagnostics through any `tracing` subscriber (JSON stdout, OpenTelemetry, Datadog). Zero overhead when no subscriber is installed.

- **HTTP sync bounded thread pool** — `HttpSyncHook` no longer spawns a new OS thread per write event. A fixed pool of 4 background workers shares a bounded channel (capacity 256). Events are dropped with a `tracing::warn!` when the pool is saturated, rather than spawning unbounded threads. Each worker creates its own `reqwest::blocking::Client` to avoid the "cannot drop runtime in async context" panic in tokio test environments.

- **Snapshot size guard** — `Database::restore_from_snapshot()` now rejects inputs larger than 10 GiB, preventing OOM conditions from corrupted or crafted snapshots.

## [0.6.1] - 2026-04-13

### Added

- **Auto `_changed_at` stamping** — every `insert`, `insertMany`, `updateOne`, and `updateMany` now automatically sets `_changed_at` to the current wall-clock time. Developers no longer need to call `stamp()` manually. `insert_with_id` (used by the sync adapter to import remote documents) is intentionally exempt so remote timestamps are never overwritten.

- **`_changed_at` secondary index** — the first mutating call on any collection automatically creates a secondary B-tree index on `_changed_at`. `export_changes` now uses an index range scan (`Filter::Gt`) instead of a full table scan, reducing export cost from O(N) to O(log N + results).

- **Delete tombstones** — `delete_one`, `delete_many`, and `delete_by_id` now write a timestamped tombstone entry to a per-collection `tomb::<name>` table after every hard delete. `export_changes` includes tombstone entries in the returned changeset so deletions propagate correctly to remote replicas that poll after the delete occurred. `import_changes` writes tombstones locally on receipt so they can be forwarded to further downstream peers.

- **`tomb_table_name(collection)` helper** — new public function in `taladb-core::index` returning the `"tomb::<name>"` table name; used internally by the sync adapter and tombstone compaction.

- **`Collection::compact_tombstones(before_ms)`** — prune tombstones older than `before_ms` (milliseconds since Unix epoch) from a collection. Returns the count of entries removed. Call periodically once all replicas are known to have received older deletions.

- **`WorkerDB::compactTombstones(collection, beforeMs)`** — Wasm binding for tombstone compaction, dispatched as the `compactTombstones` op in the Worker.

- **Bidirectional sync changeset API** — `WorkerDB::exportChangeset(collectionsJson, sinceMs)` and `WorkerDB::importChangeset(changesetJson)` are now exposed as `#[wasm_bindgen]` methods and as `exportChangeset` / `importChangeset` Worker ops. Enables pull-based sync over any transport (fetch polling, WebSocket, SSE) without baking a transport into the library. Uses `LastWriteWins` with ULID tie-breaking for deterministic merge.

- **`WorkerDB::listCollections()`** — returns a JSON array of all collection names in the database. Used internally by the secondary-tab write relay; also available to application code via the `listCollections` Worker op.

- **Secondary-tab write propagation** — writes on a non-primary (IndexedDB-fallback) tab are now relayed to the primary (OPFS) tab automatically. After every mutating op, a fallback tab exports a delta changeset and posts it on the `BroadcastChannel`. The primary tab calls `importChangeset`, merges the changes into OPFS via Last-Write-Wins, and broadcasts `taladb:changed` so all tabs stay consistent. No application code required.

- **Debounced IDB snapshot** — the IndexedDB fallback path previously flushed a full snapshot after every single write. Flushes are now debounced: the write fires after 500 ms of idle or at most every 5 s under continuous load. `db.close()` performs a synchronous flush before releasing the Web Lock so no writes are lost on tab close.

- **`Changeset`, `LastWriteWins`, `SyncAdapter` re-exported** — these types are now re-exported from the `taladb-core` crate root alongside the existing `SyncHook` / `SyncEvent` re-exports.

- **`Database::backend()`** — new `pub(crate)` accessor returning the raw `&dyn StorageBackend`; used by the sync adapter to read/write tombstone tables directly without going through the collection API.

### Fixed

- **`import_changes` applied count for missing deletes** — `ChangeOp::Delete` previously incremented `applied` unconditionally, causing `import_delete_nonexistent_returns_zero` to fail. The tombstone is still written (so the deletion can be forwarded) but `applied` only increments when the document actually existed locally.

- **`export_changes_returns_docs_after_since_ms` test** — the test constructed documents with controlled `_changed_at` values by calling `stamp()` then overriding the field before passing to `col.insert()`. Auto-stamping inside `insert()` silently discarded the override. The test now uses `Document::new` + `col.insert_with_id` (the import path) to plant documents with precise timestamps.

### Docs

- **`web.md` fully rewritten** — restructured to reflect all new capabilities: multi-tab behaviour section with ASCII flow diagram, bidirectional sync section with fetch-polling example, tombstone management with `compactTombstones` usage, conflict resolution explanation. Limitations section updated: secondary-tab writes no longer listed as a hard limitation; snapshot size ceiling and HNSW threading constraint documented accurately.

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

[Unreleased]: https://github.com/thinkgrid-labs/taladb/compare/v0.7.3...HEAD
[0.7.3]: https://github.com/thinkgrid-labs/taladb/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/thinkgrid-labs/taladb/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/thinkgrid-labs/taladb/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/thinkgrid-labs/taladb/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.2.1...v0.4.0
[0.2.1]: https://github.com/thinkgrid-labs/taladb/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/thinkgrid-labs/taladb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/thinkgrid-labs/taladb/releases/tag/v0.1.0
