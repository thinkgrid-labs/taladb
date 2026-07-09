# Changelog

All notable changes to TalaDB will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3] - 2026-07-09

Published benchmarks and a Node.js vector-index fix. Ships a rebuilt `.node`
binary — `@taladb/node` gains HNSW support.

### Fixed

- **`@taladb/node` — HNSW vector indexes were silently unavailable** — the prebuilt native module was compiled without the `vector-hnsw` feature, so `createVectorIndex(..., { indexType: 'hnsw' })` and `upgradeVectorIndex()` were silent no-ops and every `findNearest` ran the flat (brute-force) path regardless of the requested index type. The published binary now compiles with `vector-hnsw`; measured at 50k × 384-dim vectors, HNSW answers in 14.6 ms vs 188 ms flat, with 100% recall@10 on clustered (embedding-like) test vectors — see the benchmarks page for the recall and graph-build-cost caveats. (Web and React Native binaries still ship flat-only; enabling HNSW there is tracked separately — WASM size and mobile memory need evaluation first.)

### Added

- **Benchmark suite — `scripts/bench.mjs` (`pnpm bench`)** — reproducible benchmarks against the release `@taladb/node` build: document write throughput (single vs batched), query latency at 100k documents (point get, indexed equality/range, full scan), and vector search at 1k–100k × 384-dim vectors (flat and HNSW, including hybrid pre-filtered search and recall measurement). Deterministic seeded data, medians after warmup.
- **Browser benchmark suite — `scripts/bench-web.mjs` (`pnpm bench:web`)** — the same workload against `@taladb/web` in real headless Chrome with OPFS active, driven over the worker message protocol with no automation dependency (the page reports results back over HTTP). Confirms WASM vector search at parity with native and documents the browser's debounced-snapshot durability model.
- **Docs — `/benchmarks` page** — full result tables for both runtimes, methodology, and tuning guidance (batch your writes, index your hybrid filter fields, prefer one-sided indexed ranges), plus a performance summary in the README.

### Known limitations (documented, not new)

- Two-sided indexed ranges (`$gte` + `$lt` on the same field) use the index for the lower bound only and post-filter the rest; the greedy planner does not yet emit bounded range plans.
- `findNearest` pre-filters materialise full documents (including embedding fields) to collect matching ids; an id-only path would make hybrid queries cheaper.

## [0.8.2] - 2026-06-12

Hardening: sync data-loss fixes, query
correctness on mixed numeric types, security fixes in Studio and the bindings,
and a real live-query API. Ship the npm packages and the prebuilt `.node` /
WASM artifacts together — the JS↔native surface changed in this release.

### Security

- **`taladb-cli` — Studio bound to `0.0.0.0` with no authentication** — anyone on the local network could browse and **delete** documents. Studio now binds `127.0.0.1` by default (new `--host` flag opts out, with a loud warning) and validates the `Host` header against DNS-rebinding attacks, returning `403` for requests carrying a foreign hostname.
- **`@taladb/react-native` — malformed filters silently became match-all** — `parse_filter` degraded any unparseable filter (e.g. a typo'd operator like `{"status":{"$qe":"x"}}`) to `Filter::All`, so a malformed filter passed to `deleteMany`/`updateMany` destroyed or rewrote the **entire collection**. Invalid filters now error through the FFI `taladb_last_error` channel at every call site, and a malformed `findNearest` pre-filter errors instead of silently running an unfiltered search.
- **`taladb-core` — field-level encryption AAD now bound to the document** — ciphertexts were bound to the field name only, so an attacker with write access to the file could transplant doc A's encrypted `ssn` into doc B undetected. New ciphertexts use `field:<doc_id>:<field>` AAD; reads fall back to the legacy field-only AAD so existing data stays readable and upgrades on its next write.
- **`taladb-core` — ULID generation no longer ignores entropy failure** — a failing system RNG previously produced ULIDs with a zeroed random field (predictable, collision-prone); it now panics with a clear message.

### Fixed

- **`taladb-core` — sync: updates propagated to peers as deletions** — applying a remote upsert (LWW), a CRDT merge, or `CrdtSyncAdapter::update_fields` replaced documents via `delete_by_id` + `insert_with_id`, leaving a delete tombstone newer than the document itself. The next export emitted a `Delete` that destroyed the updated document on every peer. All three paths now use the new atomic `Collection::replace_with_id`, which maintains indexes against the previous version and clears the tombstone. Covered by new update → export → import → export → import round-trip tests for both adapters.
- **`taladb-core` — LWW `Delete` import ignored timestamps** — a stale remote tombstone unconditionally deleted a newer local document. Deletions now apply only when `changed_at` is at least as new as the local `_changed_at` (deletes win exact ties), and stale upserts can no longer resurrect a more recently deleted document (tombstone timestamp is checked before re-inserting).
- **`taladb-core` — LWW equal-timestamp conflicts permanently diverged** — the tie-break compared `change.id > local_doc.id`, which is the *same* ULID, so it was always false and each replica kept its own version. Ties now break on the serialized document bytes — a symmetric comparison every replica resolves identically.
- **`taladb-core` — indexed numeric range queries missed cross-type values** — index keys are type-prefixed (`Int` sorts below `Float`), but filters compare Int↔Float numerically. `$lt`/`$lte` with an Int bound never scanned the Float block (and `$gt`/`$gte` with a Float bound never scanned Ints), so `{price: {$lt: 11}}` on an indexed field silently missed `10.5` — the default situation from JavaScript, where `10` maps to Int and `10.5` to Float. The planner now unions a conservatively-widened range of the other numeric type; indexed and unindexed results are asserted identical by new parity tests. Also fixes `$eq` on `0.0` missing stored `-0.0` (and vice versa).
- **`taladb-core` — stale per-handle index cache corrupted indexes** — each `Database::collection()` call got its own index-definition cache, so creating an index through one handle left every other live handle unaware: their writes skipped maintaining the new index forever. The cache is now shared per `Database`, keyed by collection.
- **`taladb-core` — TOCTOU race in filtered mutations** — `update_one/many` and `delete_one/many` gathered candidates in a read snapshot, then mutated in a separate write transaction using the stale documents, losing concurrent updates and leaking stale index entries. Every candidate is now re-fetched and re-checked against the filter inside the exclusive write transaction.
- **`taladb-core` — storage errors during index-definition loading were swallowed** — `unwrap_or_default()` treated transient read errors as "no indexes", silently skipping index maintenance on writes. Errors now propagate (only a genuinely missing table maps to empty).
- **`taladb-core` — encryption: v0→v1 migration could permanently destroy ~1/256 of values** — a v0 ciphertext whose random nonce happens to start with `0x01` was misdetected as already-v1 and skipped; once the rest of the table migrated, it became undecryptable. Migration now verifies "looks like v1" values with an actual decrypt before skipping.
- **`taladb-core` — `find_by_id` and `find_nearest` returned ciphertext for encrypted fields** — both now decrypt configured fields like `find` does; `replace_with_id` re-encrypts symmetrically.
- **`taladb-core` — audit log was not atomic with its mutation** — audit rows were written in a separate transaction after commit: a crash could persist the mutation without its audit row, and an audit error returned `Err` for an already-committed write. Audit rows now commit inside the mutation's own transaction.
- **`taladb-core` — `$in` with duplicate values returned duplicate documents** — adjacent-only `Vec::dedup` missed interleaved ULIDs from identical ranges; now deduplicated with a set.
- **`taladb-core` — `$inc` arithmetic** — i64 overflow now errors instead of wrapping in release builds; `Float += Int` works (previously a `TypeError` while `Int += Float` succeeded); a non-numeric `$inc` delta is rejected.
- **`taladb-core` — `rekey` could not recover from an interrupted run** — each table commits separately, so a partial run left mixed keys and a re-run failed on its own progress. Values that already decrypt under the new key are now skipped, making `rekey` safely re-runnable.
- **`taladb-core` — `Document` accepted duplicate field names** — `get`/`set` only ever saw the first occurrence, but all duplicates serialized to storage. Duplicates are now dropped at construction (first occurrence wins).
- **`taladb-core` — HNSW results shrank below `top_k` after deletions** — deleted ids linger in the in-memory graph and were filtered out of results without replacement. The HNSW path now over-fetches to compensate, and the staleness contract (rebuild via `upgrade_vector_index` after bulk writes) is documented on `find_nearest`.
- **`taladb` — `useFind` stuck on `loading: true` for empty collections** — the browser `subscribe` initialized its change-detection state to `'[]'`, so an initially-empty result was never delivered. First snapshot now always fires.
- **`taladb` — WorkerProxy promises hung forever if the worker died** — in-flight requests are now rejected on `worker.onerror` and on `close()`, and new requests fail fast once the proxy is dead.
- **`@taladb/web` — HTTP sync events could arrive out of order** — one concurrent `fetch` per event let retries reorder deliveries (an update could reach the endpoint before its insert). Events now drain through a strict FIFO queue.
- **`taladb-core` — watch notifications could be silently skipped under lock contention** — `notify` used `try_lock`; a committed write that lost the race never woke its watchers. Now takes the lock.
- **`@taladb/react-native` — `listIndexes()` returned a malformed empty object**; now returns the correct `{ btree: [], fts: [], vector: [] }` shape.

### Added

- **`taladb-core` — `Collection::watch(filter)`: live queries in the Rust core** — the previously-unwired `watch` module is now connected to every write path. A `WatchHandle` yields a fresh snapshot of matching documents after each insert/update/delete, across all handles of the same `Database` (one registry per collection). Rapid writes coalesce; the query re-runs at receive time so no state is ever skipped.
- **`taladb-core` — `Collection::replace_with_id(doc)`** — atomic insert-or-replace preserving the ULID: maintains all indexes against the previous version, clears any delete tombstone, and re-encrypts configured fields. The building block used by both sync adapters.
- **`taladb-core` / `@taladb/web` — explicit `removed_fields` in update sync payloads** — `SyncEvent::Update` now carries a `removed` list and HTTP payloads include `"removed_fields": [...]`, disambiguating "field removed" from "field set to null". Nulls are still emitted in `changes` for older receivers.
- **`@taladb/node` — `close()` and async write variants** — `close()` releases the database file handle/lock; `insertAsync`, `insertManyAsync`, `updateOneAsync`, `updateManyAsync`, `deleteOneAsync`, `deleteManyAsync` run on the libuv thread pool instead of blocking the event loop. The universal `taladb` adapter routes through them automatically, falling back to the sync calls on older prebuilt binaries.
- **Operator parity across bindings** — `$contains` and `$regex` on Node, `$regex` on web (both previously unreachable from those platforms despite core support).
- **`taladb-core` — `_id` primary-key fast path** — `$eq`/`$in` filters on `_id` (including inside `$and`) now resolve to direct point lookups instead of a full collection scan.
- **`taladb-cli` — `taladb studio --host <addr>`** — explicit opt-in for non-loopback binding (see Security).

### Changed

- **Breaking: `{field: {}}` (empty operator object) is now an error on every binding** — previously it errored on Node but silently matched **all documents** on web and React Native. `{}` / `null` as the whole filter still mean match-all.
- **Breaking: collection names starting with `_` are reserved** — `db.collection("_audit")` now returns `InvalidName`, enforcing the audit log's append-only guarantee. System collections are also excluded from `list_collection_names()` / `listCollections()` / Studio.
- **Breaking: an audit-log write failure now fails (rolls back) the mutation** — previously the mutation committed and the API returned an error anyway, inviting duplicate retries.
- **Performance** — `count(filter)` no longer decrypts field contents; mutations no longer open an extra write transaction per call to ensure the `_changed_at` index; `HttpSyncHook` builds its exclude-field set once instead of per event; `useFind`-style pollers are unchanged but cross-tab writes still nudge immediately via BroadcastChannel.

## [0.8.0] - 2026-05-14

### Added

- **`taladb-core` — `CrdtSyncAdapter`: conflict-free multi-device sync with per-field logical clocks** — new `crdt` module implementing bidirectional CRDT-based sync that merges concurrent writes at field granularity rather than whole-document LWW. Two devices can independently write different fields of the same document; both changes survive after sync with no coordination required.

  - **`FieldClock { ts_ms, node_id }`** — per-field logical clock. `dominates()` compares timestamp first; `node_id` lexicographic order breaks ties deterministically across any number of replicas.
  - **`FieldMutation { field, value, clock }`** — single field-level change exported from one replica. `value: None` signals field removal.
  - **`CrdtChange { collection, id, mutations, delete_clock }`** — document-level change record. Either a set of field mutations or a delete (mutually exclusive). Deletions are propagated as tombstones via the same mechanism used by `LastWriteWins`.
  - **`CrdtChangeset = Vec<CrdtChange>`** — the serialisable unit exchanged between peers; no transport is prescribed.
  - **`CrdtAdapter` trait** — `export_crdt_changes(db, collections, since_ms)` / `import_crdt_changes(db, changeset)`.
  - **`CrdtSyncAdapter`** — concrete implementation of `CrdtAdapter`:
    - `new(node_id)` — construct with a stable per-device string identifier.
    - `with_g_set_fields(fields)` — opt specific array fields into grow-only set (G-Set) semantics: merges by union rather than LWW, so concurrent adds from any replica are always preserved.
    - `stamp_insert(fields)` / `stamp_insert_at(fields, ts_ms)` — prepare fields for a CRDT-tracked insert; stamps every non-system field with a per-field clock under `_crdt_clocks` and adds `_changed_at`.
    - `update_fields(col, id, changes)` / `update_fields_at(col, id, changes, ts_ms)` — load a document, advance clocks only for the changed fields, and write back atomically. Required for CRDT tracking on updates (replaces `col.update_one` in CRDT-aware write paths).
  - **Clock storage** — clocks are stored inline in each document as `_crdt_clocks: Object({ field: { t: ts_ms, n: node_id } })`. No schema migrations, no new storage tables. Fully compatible with databases that also use `LastWriteWins`.
  - **Export** — uses the existing `_changed_at` secondary index for an O(log N) range scan. Only exports field mutations whose individual clock is newer than `since_ms`, so incremental sync transfers the minimum necessary data.
  - **Import / merge** — for each incoming `CrdtChange`: loads the local document (or creates a new one if absent), compares per-field clocks, applies only the fields where the remote clock dominates, updates `_crdt_clocks` and `_changed_at`, then writes the merged document back. Documents not touched by the changeset are left completely untouched.
  - All public types re-exported from the crate root: `CrdtAdapter`, `CrdtChange`, `CrdtChangeset`, `CrdtSyncAdapter`, `FieldClock`, `FieldMutation`, `CRDT_CLOCKS_FIELD`.
  - 21 new integration tests in `tests/crdt.rs` covering: `stamp_insert` metadata shape, `update_fields_at` partial clock advance, concurrent writes to different fields, same-field conflict (newer wins / older loses), timestamp-tie tiebreaking by `node_id`, field removal, G-Set union, G-Set deduplication, delete ordering, export `since_ms` filtering, export → import round-trip, and three-way merge.

## [0.7.10] - 2026-04-19

### Fixed

- **`taladb` — `import.meta` crash in Metro/Hermes** — `dist/index.react-native.mjs` contained `import.meta.url` references from `createBrowserDB` and `createInMemoryBrowserDB`, which are dead code on React Native but were still included in the bundle. Hermes does not support `import.meta` syntax and threw `SyntaxError: import.meta is not supported in Hermes`. Added an esbuild `define` in the react-native tsup build to replace all `import.meta.url` occurrences at compile time.

- **`taladb` — Metro bundling failure: `@taladb/node` could not be resolved** — `createNodeDB` contains a dynamic `import('@taladb/node')` that is dead code on React Native, but Metro resolves every `import()` specifier statically even in unreachable branches. Because `@taladb/node` is an optional peer dependency, tsup automatically externalised it, leaving the specifier in the output for Metro to fail on. Fixed by adding `noExternal: ['@taladb/node']` to the react-native tsup config and using an esbuild `onResolve` plugin to redirect `@taladb/node` to an inline stub that Metro can bundle without error.

- **`taladb` — `openDB` routed to browser adapter on React Native New Architecture** — `detectPlatform()` checked `nativeCallSyncHook` first to detect React Native, but this global is no longer set in RN New Architecture (0.71+). Because React Native also exposes `window` and `navigator`, the function fell through to the browser branch and called `createBrowserDB`, which immediately crashed on the missing `Worker` global. Fixed by checking `navigator.product === 'ReactNative'` first — the canonical, version-stable React Native detection.

- **`taladb` — `createNativeDB` called non-existent `collection()` method on JSI HostObject** — the `NativeHostObject` interface modelled the JSI HostObject as a nested API (`native.collection('notes').insert(doc)`), but the actual C++ HostObject (`TalaDBHostObject.cpp`) exposes a flat API where every method takes the collection name as its first argument (`native.insert('notes', doc)`). Every collection operation threw `native.collection is not a function`. Rewrote `createNativeDB` and its `NativeDB` interface to match the actual flat JSI surface.

## [0.7.9] - 2026-04-19

### Fixed

- **`@taladb/react-native` — Android `dlopen` crash: `library libtaladb_ffi.so not found`** — `cargo ndk` builds Rust cdylib files without a SONAME. CMake's `SHARED IMPORTED` + `IMPORTED_LOCATION` recorded the full build-time path in `DT_NEEDED`, so the dynamic linker searched for a path like `../../../../src/main/jniLibs/arm64-v8a/libtaladb_ffi.so` at runtime instead of the simple `libtaladb_ffi.so` soname. Fixed by replacing the `SHARED IMPORTED` target with `link_directories()` pointing at the ABI-specific jniLibs folder and linking by name (`-ltaladb_ffi`), which produces `DT_NEEDED: libtaladb_ffi.so` and lets the Android linker find the library via its standard search path.

- **`@taladb/react-native` — `TalaDBModule.kt` was missing `apply plugin: "kotlin-android"`** — without the Kotlin plugin, Gradle could not compile the module's Kotlin source and the package class (`TalaDBPackage`) was never available. Added the plugin to `android/build.gradle`.

## [0.7.8] - 2026-04-19

### Fixed

- **`@taladb/react-native` — C++ compilation crash in `taladb.h`** — a nested `/* ... */` block comment on line 195 caused the compiler to terminate the outer comment early and attempt to parse the remaining documentation as C++ code, producing `expected unqualified-id` and `unknown type name` errors. Changed the inner comment to a `//` line comment.

## [0.7.7] - 2026-04-19

### Fixed

- **`@taladb/react-native` — Android STL mismatch** — React Native 0.76+ requires the shared C++ runtime (`c++_shared`). Without `ANDROID_STL=c++_shared` in the CMake arguments, the build system defaulted to the static STL, which is incompatible with Hermes and the TurboModule infrastructure. Added `arguments "-DANDROID_STL=c++_shared"` to `android/build.gradle`.

## [0.7.6] - 2026-04-19

### Fixed

- **`@taladb/react-native` — Android module never compiled into the app** — `android/build.gradle` was missing. Without it, Gradle did not treat `android/` as a library module — `TalaDBModule.kt` was never compiled and CMake was never invoked to build `libtaladb_jsi.so`. This was the root cause of the `TurboModuleRegistry.getEnforcing('TalaDB'): 'TalaDB' could not be found` crash on Android.

- **`@taladb/react-native` — TurboModule codegen never ran** — `codegenConfig` was missing from `package.json`. React Native's Gradle plugin reads this field to generate `NativeTalaDBSpec` — the base class `TalaDBModule.kt` extends. Without it, the Kotlin code could not compile even when `build.gradle` was present.

- **`@taladb/react-native` — missing `AndroidManifest.xml`** — added `android/src/main/AndroidManifest.xml`, required for Gradle to recognise the `android/` directory as a valid Android library module.

## [0.7.5] - 2026-04-19

### Fixed

- **`taladb` — React Native installs pulled in `@taladb/web` and `@taladb/node`** — both packages were declared as `optionalDependencies`, which package managers (npm, yarn, pnpm) install by default. Moved to optional `peerDependencies` so only the adapter the consumer actually needs is installed. **Breaking:** web and Node.js users must now explicitly install `@taladb/web` or `@taladb/node` alongside `taladb` (the docs have always shown this; the auto-install was the anomaly).

- **`taladb` — Metro bundler resolved the wrong entry point** — added a `react-native` export condition pointing to a dedicated build (`dist/index.react-native.mjs`). Metro now resolves this entry instead of the default Node.js ESM build, preventing it from statically analysing or bundling `@taladb/web` or `@taladb/node` imports.

## [0.7.4] - 2026-04-18

### Added

- **`@taladb/react-native` — Float32Array zero-copy fast path** — `findNearest` now accepts a `Float32Array` directly via JSI `ArrayBuffer` introspection, bypassing JSON serialisation entirely. Eliminates the per-call f64→f32 conversion loop for large embeddings (768 / 1024 / 1536 dimensions). Falls back to `number[]` automatically for callers that pass plain arrays.

- **`@taladb/react-native` — async vector search + full-scan** — two new JSI methods dispatched to background OS threads via a `TalaDbJob` handle:
  - `findNearestAsync(collection, field, query, topK, filter?)` → `Promise<Array>` — runs HNSW / flat ANN search off the JS thread; avoids dropping frames during large unfiltered scans.
  - `findAsync(collection, filter?)` → `Promise<Array>` — full collection scan on a background thread; keeps the JS thread responsive for paginated or unbounded queries.
  - Both return native Promises polled via `setImmediate` — no CallInvoker plumbing required, compatible with Hermes and JSC without changes to the Android or iOS module layer.

- **`@taladb/node` — Float32Array zero-copy fast path** — new `findNearestF32(field, query: Float32Array, topK, filter?)` method on `CollectionNode`. Passes the underlying `f32` slice directly to `Collection::find_nearest` without allocating a conversion buffer.

- **`@taladb/node` — async variants via napi `AsyncTask`** — two new methods that run on the libuv thread pool:
  - `findNearestAsync(field, query: Float32Array, topK, filter?)` → `Promise<Array<{ document, score }>>` — offloads ANN search to a worker thread; resolves on the JS thread.
  - `findAsync(filter?)` → `Promise<Array>` — offloads full collection scan; useful for large datasets where blocking the event loop would be noticeable.

- **Vector index management — React Native** — `createVectorIndex`, `dropVectorIndex`, and `upgradeVectorIndex` are now exposed through the JSI HostObject and declared in the TurboModule Codegen spec (`NativeTalaDB.ts`). Supports `flat` and `hnsw` index types; `opts` accepts `{ metric, m, efConstruction }`.

[0.7.4]: https://github.com/thinkgrid-labs/taladb/compare/v0.7.3...v0.7.4

## [0.7.3] - 2026-04-17

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
