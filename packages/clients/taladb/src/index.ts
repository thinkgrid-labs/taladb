import type {
  Collection,
  CollectionIndexInfo,
  CollectionOptions,
  Document,
  TalaDB,
  SyncAdapter,
  SyncOptions,
  AggregatePipeline,
} from './types';
import { loadConfig, validateConfig } from './config';
import type { TalaDbConfig, SyncConfig } from './config';
import { runSync, unsupportedSync, type SyncHandle } from './sync';

// Re-export all public types for consumers (export…from satisfies S7763)
export type {
  Collection,
  CollectionIndexInfo,
  CollectionOptions,
  Document,
  Filter,
  Schema,
  Update,
  Value,
  TalaDB,
  VectorMetric,
  VectorIndexOptions,
  VectorSearchResult,
  AggregateStage,
  AggregatePipeline,
  SyncAdapter,
  SyncOptions,
  SyncResult,
  SyncDirection,
  SerializedChangeset,
} from './types';

export { HttpSyncAdapter } from './http-adapter';

// ============================================================
// Validation
// ============================================================

/**
 * Thrown when a document fails schema validation on `insert` or `insertMany`.
 * The `cause` property holds the original error thrown by the schema library.
 */
export class TalaDbValidationError extends Error {
  constructor(
    public readonly cause: unknown,
    context?: string,
  ) {
    const label = context ? ` (${context})` : '';
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`TalaDB schema validation failed${label}: ${msg}`);
    this.name = 'TalaDbValidationError';
  }
}

/**
 * Wraps a `Collection<T>` to intercept writes (and optionally reads) through
 * the provided schema validator. Throws `TalaDbValidationError` on failure.
 */
function applySchema<T extends Document>(
  col: Collection<T>,
  options: CollectionOptions<T>,
): Collection<T> {
  const { schema, validateOnRead = false } = options;
  if (!schema) return col;

  function parseWrite(doc: unknown, label: string): T {
    try {
      return schema!.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, label);
    }
  }

  function parseRead(doc: unknown): T {
    try {
      return schema!.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, 'read');
    }
  }

  return {
    ...col,
    insert: async (doc) => {
      parseWrite(doc, 'insert');
      return col.insert(doc);
    },
    insertMany: async (docs) => {
      docs.forEach((doc, i) => parseWrite(doc, `insertMany[${i}]`));
      return col.insertMany(docs);
    },
    find: validateOnRead
      ? async (filter?) => {
          const docs = await col.find(filter);
          return docs.map((d) => parseRead(d));
        }
      : col.find.bind(col),
    findOne: validateOnRead
      ? async (filter) => {
          const doc = await col.findOne(filter);
          return doc === null ? null : parseRead(doc);
        }
      : col.findOne.bind(col),
  };
}

export type { TalaDbConfig, SyncConfig } from './config';

// ============================================================
// Platform detection + dynamic import
// ============================================================

type Platform = 'browser' | 'react-native' | 'node';

function detectPlatform(): Platform {
  // navigator.product === 'ReactNative' is the canonical check across all RN
  // versions. nativeCallSyncHook is absent in the New Architecture (RN 0.71+),
  // and window/navigator are both defined on RN (window === global), so the
  // browser check must not run before this.
  if (typeof navigator !== 'undefined' && (navigator as unknown as { product?: string }).product === 'ReactNative') {
    return 'react-native';
  }
  if ((globalThis as Record<string, unknown>).nativeCallSyncHook !== undefined) {
    return 'react-native';
  }
  // Browser: window + navigator exist
  if (globalThis.window !== undefined && typeof navigator !== 'undefined') {
    return 'browser';
  }
  return 'node';
}

// ============================================================
// Browser adapter — SharedWorker + OPFS via FileSystemSyncAccessHandle
// ============================================================

/**
 * Thin proxy that forwards every DB operation to the SharedWorker
 * via a typed message protocol and awaits the response.
 *
 * The SharedWorker (taladb.worker.js) owns the OPFS file handle and the
 * WASM + redb instance. Multiple tabs share the same worker instance so
 * there is always exactly one writer.
 */
// WorkerProxy works with both MessagePort (SharedWorker) and Worker.
// Worker does not have a .start() method; MessagePort requires it.
type WorkerLike = Pick<Worker, 'postMessage'> & { onmessage: ((e: MessageEvent) => void) | null; start?: () => void };

class WorkerProxy {
  private readonly port: WorkerLike;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private dead: Error | null = null;

  constructor(port: WorkerLike) {
    this.port = port;
    this.port.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (error === undefined) p.resolve(result);
        else p.reject(new Error(error));
      }
    };
    // MessagePort requires .start(); Worker does not have it.
    this.port.start?.();
  }

  send<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ id, op, ...args });
    });
  }

  /**
   * Reject every in-flight request and refuse new ones. Called when the
   * worker errors or is terminated — without this, pending promises would
   * hang forever (awaiting callers deadlock).
   */
  abort(reason: Error): void {
    this.dead = reason;
    for (const [, p] of this.pending) p.reject(reason);
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared subscribe helper
// ---------------------------------------------------------------------------

/**
 * Polls `findFn` every 300 ms and fires `callback` whenever the result changes
 * (detected via JSON equality). Returns an unsubscribe function.
 *
 * Used by the in-memory, Node, and React Native adapters. The browser-worker
 * adapter has its own variant that integrates with BroadcastChannel nudging.
 */
function makePoller<T extends Document>(
  findFn: () => Promise<T[]>,
  callback: (docs: T[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  let active = true;
  let lastJson = '';
  let running = false;
  let rerun = false;
  const poll = async () => {
    if (!active) return;
    if (running) { rerun = true; return; }
    running = true;
    try {
      const docs = await findFn();
      if (!active) return;
      const json = JSON.stringify(docs);
      if (json !== lastJson) {
        lastJson = json;
        callback(docs);
      }
    } catch (error) {
      if (active) onError?.(error);
    } finally {
      running = false;
      if (active) {
        if (rerun) { rerun = false; void poll(); }
        else setTimeout(poll, 300);
      }
    }
  };
  poll();
  return () => { active = false; };
}

/**
 * In-memory fallback for browsers that don't support SharedWorker (e.g. Safari iOS).
 * Data is not persisted across page reloads; all writes live in WASM memory only.
 */
async function createInMemoryBrowserDB(_dbName: string): Promise<TalaDB> {
  const wasmUrl = new URL('@taladb/web/pkg/taladb_web.js', import.meta.url);
  const wasm = await import(/* @vite-ignore */ wasmUrl.href);
  await wasm.default();
  const db = wasm.TalaDBWasm.openInMemory();

  function wrapCollection<T extends Document>(name: string, opts?: CollectionOptions<T>): Collection<T> {
    const col = db.collection(name);
    const wrapped: Collection<T> = {
      insert: async (doc) => col.insert(doc),
      insertMany: async (docs) => col.insertMany(docs),
      find: async (filter?) => col.find(filter ?? null),
      findOne: async (filter) => col.findOne(filter) ?? null,
      updateOne: async (filter, update) => col.updateOne(filter, update),
      updateMany: async (filter, update) => col.updateMany(filter, update),
      deleteOne: async (filter) => col.deleteOne(filter),
      deleteMany: async (filter) => col.deleteMany(filter),
      count: async (filter?) => col.count(filter ?? null),
      aggregate: async <R extends Document = Document>(pipeline: AggregatePipeline<T>): Promise<R[]> =>
        col.aggregate(pipeline as never) as R[],
      createIndex: async (field) => col.createIndex(field),
      dropIndex: async (field) => col.dropIndex(field),
      createCompoundIndex: async (fields) => col.createCompoundIndex(JSON.stringify(fields)),
      dropCompoundIndex: async (fields) => col.dropCompoundIndex(JSON.stringify(fields)),
      createFtsIndex: async (field) => col.createFtsIndex(field),
      dropFtsIndex: async (field) => col.dropFtsIndex(field),
      createVectorIndex: async (field, options) => {
        if (options.indexType === 'hnsw') throw new Error('HNSW vector indexes are not available in the browser (requires native threads). Use Node.js or React Native.');
        return col.createVectorIndex(field, options.dimensions, options.metric ?? null, null, null, null);
      },
      dropVectorIndex: async (field) => col.dropVectorIndex(field),
      upgradeVectorIndex: async (_field) => {
        throw new Error('HNSW vector indexes are not available in the browser (requires native threads). Use Node.js or React Native.');
      },
      findNearest: async (field, vector, topK, filter?) => {
        const raw = await col.findNearest(field, vector, topK, filter ?? null) as { document: T; score: number }[];
        return raw;
      },
      listIndexes: async () => {
        const json = col.listIndexes() as string;
        return JSON.parse(json);
      },
      subscribe: (filter, callback, onError) =>
        makePoller(async () => col.find(filter ?? null) as T[], callback, onError),
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }

  // Not annotated `: TalaDB` so the extra `listCollectionNames` (needed by the
  // internal SyncHandle, not part of the public interface) doesn't trip the
  // excess-property check. Structurally still a TalaDB.
  const handle = {
    collection: <T extends Document>(name: string, opts?: CollectionOptions<T>) => wrapCollection<T>(name, opts),
    compact: async () => {},
    close: async () => {},
    exportChanges: async (collections: string[], sinceMs: number) => db.exportChanges(sinceMs, collections) as string,
    importChanges: async (changeset: string) => db.importChanges(changeset) as number,
    listCollectionNames: async () => db.listCollectionNames() as string[],
    sync: (adapter: SyncAdapter, options: SyncOptions) =>
      runSync(handle as unknown as SyncHandle, adapter, options),
  };
  return handle satisfies TalaDB;
}

async function createBrowserDB(dbName: string, config?: TalaDbConfig, passphrase?: string): Promise<TalaDB> {
  // createSyncAccessHandle (required for OPFS persistence) is only available
  // in Dedicated Workers per the WHATWG spec — not SharedWorkers. We use a
  // DedicatedWorker so each tab gets its own isolated worker + file handle.
  const workerUrl = new URL('@taladb/web/worker/taladb.worker.js', import.meta.url);
  const worker = new Worker(workerUrl, { type: 'module', name: 'taladb' });
  const proxy = new WorkerProxy(worker);
  // A crashed worker can never answer — fail in-flight requests instead of
  // letting their promises hang forever.
  worker.onerror = (e: ErrorEvent) => {
    proxy.abort(new Error(`taladb worker error: ${e.message ?? 'unknown'}`));
  };

  // Initialize the worker (opens OPFS file or falls back to IDB-backed in-memory).
  // Pass configJson so the worker can wire up HTTP push sync from the first write.
  const configJson = config !== undefined ? JSON.stringify(config) : undefined;
  try {
    await proxy.send('init', { dbName, configJson, passphrase });
  } catch (e) {
    // A failed init (wrong passphrase, OPFS unavailable, …) must not leave a
    // zombie worker behind: terminating it force-closes any OPFS access
    // handles it acquired, so the caller can retry (e.g. re-prompt for the
    // passphrase) without reloading the page.
    proxy.abort(e instanceof Error ? e : new Error(String(e)));
    worker.terminate();
    throw e;
  }

  // BroadcastChannel: when another tab's worker commits a write it posts
  // "taladb:changed".  We immediately nudge every active subscribe() poller
  // so it re-runs without waiting for the next 300 ms tick.
  const nudgeCallbacks = new Set<() => void>();
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(`taladb:${dbName}`);
    channel.onmessage = (e: MessageEvent) => {
      if (e.data === 'taladb:changed') {
        for (const nudge of nudgeCallbacks) nudge();
      }
    };
  }

  function wrapCollection<T extends Document>(name: string, opts?: CollectionOptions<T>): Collection<T> {
    const s = JSON.stringify;
    const wrapped: Collection<T> = {
      insert: (doc) =>
        proxy.send<string>('insert', { collection: name, docJson: s(doc) }),

      insertMany: async (docs) => {
        const json = await proxy.send<string>('insertMany', {
          collection: name, docsJson: s(docs),
        });
        return JSON.parse(json) as string[];
      },

      find: async (filter?) => {
        const json = await proxy.send<string>('find', {
          collection: name, filterJson: filter ? s(filter) : 'null',
        });
        return JSON.parse(json) as T[];
      },

      findOne: async (filter) => {
        const json = await proxy.send<string>('findOne', {
          collection: name, filterJson: filter ? s(filter) : 'null',
        });
        return JSON.parse(json) as T | null;
      },

      updateOne: (filter, update) =>
        proxy.send<boolean>('updateOne', {
          collection: name, filterJson: s(filter), updateJson: s(update),
        }),

      updateMany: (filter, update) =>
        proxy.send<number>('updateMany', {
          collection: name, filterJson: s(filter), updateJson: s(update),
        }),

      deleteOne: (filter) =>
        proxy.send<boolean>('deleteOne', { collection: name, filterJson: s(filter) }),

      deleteMany: (filter) =>
        proxy.send<number>('deleteMany', { collection: name, filterJson: s(filter) }),

      count: (filter?) =>
        proxy.send<number>('count', {
          collection: name, filterJson: filter ? s(filter) : 'null',
        }),

      aggregate: async <R extends Document = Document>(pipeline: AggregatePipeline<T>): Promise<R[]> => {
        const json = await proxy.send<string>('aggregate', {
          collection: name, pipelineJson: s(pipeline),
        });
        return JSON.parse(json) as R[];
      },

      createIndex: (field) =>
        proxy.send<void>('createIndex', { collection: name, field }),

      dropIndex: (field) =>
        proxy.send<void>('dropIndex', { collection: name, field }),

      createCompoundIndex: (fields) =>
        proxy.send<void>('createCompoundIndex', { collection: name, fieldsJson: JSON.stringify(fields) }),

      dropCompoundIndex: (fields) =>
        proxy.send<void>('dropCompoundIndex', { collection: name, fieldsJson: JSON.stringify(fields) }),

      createFtsIndex: (field) =>
        proxy.send<void>('createFtsIndex', { collection: name, field }),

      dropFtsIndex: (field) =>
        proxy.send<void>('dropFtsIndex', { collection: name, field }),

      createVectorIndex: (field, options) => {
        if (options.indexType === 'hnsw') return Promise.reject(new Error('HNSW vector indexes are not available in the browser (requires native threads). Use Node.js or React Native.'));
        return proxy.send<void>('createVectorIndex', {
          collection: name,
          field,
          dimensions: options.dimensions,
          metric: options.metric,
          indexType: null,
          hnswM: null,
          hnswEfConstruction: null,
        });
      },

      dropVectorIndex: (field) =>
        proxy.send<void>('dropVectorIndex', { collection: name, field }),

      upgradeVectorIndex: (_field) =>
        Promise.reject(new Error('HNSW vector indexes are not available in the browser (requires native threads). Use Node.js or React Native.')),

      listIndexes: async () => {
        const json = await proxy.send<string>('listIndexes', { collection: name });
        return JSON.parse(json);
      },

      findNearest: async (field, vector, topK, filter?) => {
        const json = await proxy.send<string>('findNearest', {
          collection: name,
          field,
          queryJson: JSON.stringify(vector),
          topK,
          filterJson: filter ? JSON.stringify(filter) : 'null',
        });
        return JSON.parse(json) as { document: T; score: number }[];
      },

      subscribe: (filter, callback, onError) => {
        let active = true;
        // Must start empty (not '[]') so the first snapshot is always
        // delivered — otherwise an initially-empty collection never fires the
        // callback and useFind stays in loading state forever.
        let lastJson = '';
        let timer: ReturnType<typeof setTimeout> | null = null;
        let running = false;
        let rerun = false;

        const poll = async () => {
          if (!active) return;
          if (running) { rerun = true; return; }
          running = true;
          // Cancel any pending tick — we're running now (either nudged or ticked).
          if (timer !== null) { clearTimeout(timer); timer = null; }
          try {
            const json = await proxy.send<string>('find', {
              collection: name, filterJson: filter ? s(filter) : 'null',
            });
            if (!active) return;
            if (json !== lastJson) {
              lastJson = json;
              callback(JSON.parse(json) as T[]);
            }
          } catch (error) {
            if (active) onError?.(error);
          } finally {
            running = false;
          }
          // Schedule the next polling tick (fallback when BroadcastChannel
          // is unavailable or for same-tab writes).
          if (active) {
            if (rerun) { rerun = false; void poll(); }
            else timer = setTimeout(poll, 300);
          }
        };

        // Register with the BroadcastChannel nudge set so cross-tab writes
        // immediately re-trigger this poller.
        nudgeCallbacks.add(poll);
        poll();
        return () => {
          active = false;
          nudgeCallbacks.delete(poll);
          if (timer !== null) { clearTimeout(timer); timer = null; }
        };
      },
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }

  // Not annotated `: TalaDB` so the extra `listCollectionNames` (needed by the
  // internal SyncHandle, not part of the public interface) doesn't trip the
  // excess-property check. Structurally still a TalaDB.
  const handle = {
    collection: <T extends Document>(name: string, opts?: CollectionOptions<T>) => wrapCollection<T>(name, opts),
    compact: () => proxy.send<void>('compact'),
    syncStatus: async () => JSON.parse(await proxy.send<string>('syncStatus')) as { pending: number; dropped: number; failed: number },
    flushSync: (timeoutMs = 5000) => proxy.send<boolean>('flushSync', { timeoutMs }),
    close: async () => {
      channel?.close();
      try {
        await proxy.send<void>('close');
      } finally {
        worker.terminate();
        proxy.abort(new Error('taladb worker closed'));
      }
    },
    // All engine work (export scan, LWW merge) runs inside the worker, off the
    // main thread — a sync pass never blocks rendering, whatever its size.
    exportChanges: (collections: string[], sinceMs: number) =>
      proxy.send<string>('exportChangeset', { collectionsJson: JSON.stringify(collections), sinceMs }),
    importChanges: (changeset: string) =>
      proxy.send<number>('importChangeset', { changesetJson: changeset }),
    listCollectionNames: async () =>
      JSON.parse(await proxy.send<string>('listCollections')) as string[],
    sync: (adapter: SyncAdapter, options: SyncOptions) =>
      runSync(handle as unknown as SyncHandle, adapter, options),
  };
  return handle satisfies TalaDB;
}

// ============================================================
// Node.js adapter (wraps @taladb/node native module)
// ============================================================

async function createNodeDB(dbName: string, config?: TalaDbConfig, passphrase?: string): Promise<TalaDB> {
  // @taladb/node ships platform-specific .node binaries
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — types generated by `napi build`; not available until package is built
  const native = await import('@taladb/node');
  // napi-rs normalizes the Rust struct `TalaDBNode` to the JS class `TalaDbNode`;
  // accept both so a future regeneration can't silently break openDB again.
  const TalaDBNode = (native as Record<string, any>).TalaDbNode ?? (native as Record<string, any>).TalaDBNode;
  if (!TalaDBNode) throw new Error('@taladb/node loaded but exports no TalaDbNode class — rebuild the native module');
  const configJson = config !== undefined ? JSON.stringify(config) : null;
  const db = TalaDBNode.open(dbName, configJson, passphrase ?? null);

  function wrapCollection<T extends Document>(name: string, opts?: CollectionOptions<T>): Collection<T> {
    const col = db.collection(name);
    // Prefer the *Async native variants (added in 0.8.1): they run on the
    // libuv thread pool instead of blocking the JS event loop. Fall back to
    // the sync calls when running against an older prebuilt .node binary.
    const wrapped: Collection<T> = {
      insert: async (doc) =>
        col.insertAsync ? col.insertAsync(doc as Record<string, unknown>) : col.insert(doc as Record<string, unknown>),
      insertMany: async (docs) =>
        col.insertManyAsync ? col.insertManyAsync(docs as Record<string, unknown>[]) : col.insertMany(docs as Record<string, unknown>[]),
      find: async (filter?) =>
        col.findAsync ? col.findAsync(filter ?? null) : col.find(filter ?? null),
      findOne: async (filter) => col.findOne(filter) ?? null,
      updateOne: async (filter, update) =>
        col.updateOneAsync ? col.updateOneAsync(filter, update) : col.updateOne(filter, update),
      updateMany: async (filter, update) =>
        col.updateManyAsync ? col.updateManyAsync(filter, update) : col.updateMany(filter, update),
      deleteOne: async (filter) =>
        col.deleteOneAsync ? col.deleteOneAsync(filter) : col.deleteOne(filter),
      deleteMany: async (filter) =>
        col.deleteManyAsync ? col.deleteManyAsync(filter) : col.deleteMany(filter),
      count: async (filter?) => col.count(filter ?? null),
      aggregate: async <R extends Document = Document>(pipeline: AggregatePipeline<T>): Promise<R[]> =>
        col.aggregate(pipeline as never) as R[],
      createIndex: async (field) => col.createIndex(field),
      dropIndex: async (field) => col.dropIndex(field),
      createCompoundIndex: async (fields) => col.createCompoundIndex(fields as string[]),
      dropCompoundIndex: async (fields) => col.dropCompoundIndex(fields as string[]),
      createFtsIndex: async (field) => col.createFtsIndex(field),
      dropFtsIndex: async (field) => col.dropFtsIndex(field),
      createVectorIndex: async (field, options) =>
        col.createVectorIndex(field, options.dimensions, options.metric ?? null, options.indexType ?? null, options.hnswM ?? null, options.hnswEfConstruction ?? null),
      dropVectorIndex: async (field) => col.dropVectorIndex(field),
      upgradeVectorIndex: async (field) => col.upgradeVectorIndex(field),
      listIndexes: async () => {
        const json = col.listIndexes() as string;
        return JSON.parse(json);
      },
      findNearest: async (field, vector, topK, filter?) => {
        const raw = await col.findNearest(field, vector, topK, filter ?? null) as { document: T; score: number }[];
        return raw;
      },
      subscribe: (filter, callback, onError) =>
        makePoller(async () => col.find(filter ?? null) as T[], callback, onError),
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }

  // Not annotated `: TalaDB` so the extra `listCollectionNames` (needed by the
  // internal SyncHandle, not part of the public interface) doesn't trip the
  // excess-property check. Structurally still a TalaDB.
  const handle = {
    collection: <T extends Document>(name: string, opts?: CollectionOptions<T>) => wrapCollection<T>(name, opts),
    compact: async () => db.compact(),
    // Releases the native file handle/lock (no-op on older .node binaries).
    close: async () => db.close?.(),
    exportChanges: async (collections: string[], sinceMs: number) => db.exportChanges(sinceMs, collections),
    importChanges: async (changeset: string) => db.importChanges(changeset),
    listCollectionNames: async () => db.listCollectionNames(),
    sync: (adapter: SyncAdapter, options: SyncOptions) =>
      runSync(handle as unknown as SyncHandle, adapter, options),
  };
  return handle satisfies TalaDB;
}

// ============================================================
// React Native adapter (wraps JSI HostObject installed by @taladb/react-native)
// ============================================================

// The JSI HostObject is a flat API: every method takes the collection name as
// its first argument. There is no intermediate collection(name) sub-object.
interface NativeDB {
  insert(collection: string, doc: Record<string, unknown>): string;
  insertMany(collection: string, docs: Record<string, unknown>[]): string[];
  find(collection: string, filter: Record<string, unknown>): Record<string, unknown>[];
  findOne(collection: string, filter: Record<string, unknown>): Record<string, unknown> | null;
  updateOne(collection: string, filter: Record<string, unknown>, update: Record<string, unknown>): boolean;
  updateMany(collection: string, filter: Record<string, unknown>, update: Record<string, unknown>): number;
  deleteOne(collection: string, filter: Record<string, unknown>): boolean;
  deleteMany(collection: string, filter: Record<string, unknown>): number;
  count(collection: string, filter: Record<string, unknown>): number;
  aggregate(collection: string, pipeline: unknown[]): Record<string, unknown>[];
  createIndex(collection: string, field: string): void;
  dropIndex(collection: string, field: string): void;
  createCompoundIndex(collection: string, fields: string[]): void;
  dropCompoundIndex(collection: string, fields: string[]): void;
  createFtsIndex(collection: string, field: string): void;
  dropFtsIndex(collection: string, field: string): void;
  createVectorIndex(collection: string, field: string, dimensions: number, opts?: Record<string, unknown>): void;
  dropVectorIndex(collection: string, field: string): void;
  upgradeVectorIndex(collection: string, field: string): void;
  findNearest(collection: string, field: string, query: number[], topK: number, filter?: Record<string, unknown> | null): { document: Record<string, unknown>; score: number }[];
  compact(): void;
  close(): void;
  // Bidirectional-sync primitives. Optional: only present on binaries built
  // with the sync HostObject methods (added in 0.9.x). Absent on older
  // prebuilt native modules, in which case db.sync() falls back to a clear
  // "not available" error rather than crashing.
  exportChanges?(collectionsJson: string[], sinceMs: number): string;
  importChanges?(changeset: string): number;
  listCollectionNames?(): string[];
}

async function createNativeDB(_dbName: string): Promise<TalaDB> {
  // The JSI HostObject is installed by @taladb/react-native's TurboModule
  // at app startup via TalaDBModule.initialize(dbName).
  // After that, it is available at globalThis.__TalaDB__.
  const maybeNative = (globalThis as Record<string, unknown>).__TalaDB__ as NativeDB | undefined;
  if (!maybeNative) {
    throw new Error(
      '@taladb/react-native JSI HostObject not found. ' +
      'Did you call TalaDBModule.initialize() in your app entry point?'
    );
  }
  const native: NativeDB = maybeNative;

  function wrapCollection<T extends Document>(name: string, opts?: CollectionOptions<T>): Collection<T> {
    const wrapped: Collection<T> = {
      insert: async (doc) => native.insert(name, doc as Record<string, unknown>),
      insertMany: async (docs) => native.insertMany(name, docs as Record<string, unknown>[]),
      find: async (filter?) => native.find(name, filter ?? {}) as T[],
      findOne: async (filter) => native.findOne(name, filter ?? {}) as T | null,
      updateOne: async (filter, update) => native.updateOne(name, filter, update),
      updateMany: async (filter, update) => native.updateMany(name, filter, update),
      deleteOne: async (filter) => native.deleteOne(name, filter),
      deleteMany: async (filter) => native.deleteMany(name, filter),
      count: async (filter?) => native.count(name, filter ?? {}),
      aggregate: async <R extends Document = Document>(pipeline: AggregatePipeline<T>): Promise<R[]> =>
        native.aggregate(name, pipeline as unknown[]) as R[],
      createIndex: async (field) => native.createIndex(name, field),
      dropIndex: async (field) => native.dropIndex(name, field),
      createCompoundIndex: async (fields) => native.createCompoundIndex(name, fields as string[]),
      dropCompoundIndex: async (fields) => native.dropCompoundIndex(name, fields as string[]),
      createFtsIndex: async (field) => native.createFtsIndex(name, field),
      dropFtsIndex: async (field) => native.dropFtsIndex(name, field),
      createVectorIndex: async (field, options) => {
        const opts: Record<string, unknown> = {};
        if (options.metric) opts.metric = options.metric;
        if (options.hnswM || options.hnswEfConstruction) {
          opts.hnsw = { m: options.hnswM, efConstruction: options.hnswEfConstruction };
        }
        return native.createVectorIndex(name, field, options.dimensions, opts);
      },
      dropVectorIndex: async (field) => native.dropVectorIndex(name, field),
      upgradeVectorIndex: async (field) => native.upgradeVectorIndex(name, field),
      // The JSI HostObject does not expose index introspection yet; return a
      // correctly-shaped empty result rather than `{}` cast to the interface.
      listIndexes: async (): Promise<CollectionIndexInfo> => ({ btree: [], fts: [], vector: [] }),
      findNearest: async (field, vector, topK, filter?) => {
        const raw = native.findNearest(name, field, vector, topK, filter ?? null);
        return raw as { document: T; score: number }[];
      },
      subscribe: (filter, callback, onError) =>
        makePoller(async () => native.find(name, filter ?? {}) as T[], callback, onError),
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }

  // Bidirectional sync is available only when the native module exposes the
  // changeset primitives (0.9.x+ JSI HostObject). Feature-detect so an older
  // prebuilt binary degrades to a clear error instead of a hard crash.
  const syncSurface =
    typeof native.exportChanges === 'function' &&
    typeof native.importChanges === 'function' &&
    typeof native.listCollectionNames === 'function'
      ? (() => {
          const handle = {
            collection: <T extends Document>(name: string, opts?: CollectionOptions<T>) => wrapCollection<T>(name, opts),
            exportChanges: async (collections: string[], sinceMs: number) => native.exportChanges!(collections, sinceMs),
            importChanges: async (changeset: string) => native.importChanges!(changeset),
            listCollectionNames: async () => native.listCollectionNames!(),
            sync: (adapter: SyncAdapter, options: SyncOptions) =>
              runSync(handle as unknown as SyncHandle, adapter, options),
          };
          return {
            exportChanges: handle.exportChanges,
            importChanges: handle.importChanges,
            sync: handle.sync,
          };
        })()
      : unsupportedSync('react-native');

  return {
    collection: <T extends Document>(name: string, opts?: CollectionOptions<T>) => wrapCollection<T>(name, opts),
    compact: async () => native.compact(),
    close: async () => native.close(),
    ...syncSurface,
  };
}

// ============================================================
// Public entry point
// ============================================================

/** Options for `openDB`. */
export interface OpenDBOptions {
  /** Encrypt native database values at rest. Never hard-code this value. */
  passphrase?: string;
  /**
   * Explicit path to a `taladb.config.yml` / `taladb.config.json` file.
   * If omitted, TalaDB auto-discovers the file from `process.cwd()` on Node.js.
   * Ignored on browser and React Native — those platforms do not support
   * file-based config discovery. Pass `config` inline instead, or on React Native
   * pass `JSON.stringify(config)` as the second argument to `TalaDBModule.initialize`.
   */
  configPath?: string;
  /**
   * Inline config object. Takes precedence over any config file when provided.
   * Useful for passing config programmatically without a config file on disk.
   */
  config?: TalaDbConfig;
}

/**
 * Open a TalaDB database.
 *
 * @param dbName   Name of the database file (used for OPFS and native file paths).
 * @param options  Optional config. Pass `{ config }` for inline sync settings or
 *                 `{ configPath }` to load from a specific file.
 *
 * @example
 * const db = await openDB('myapp.db');
 *
 * @example with inline sync config
 * const db = await openDB('myapp.db', {
 *   config: { sync: { enabled: true, endpoint: 'https://api.example.com/events' } },
 * });
 */
export async function openDB(dbName = 'taladb.db', options?: OpenDBOptions): Promise<TalaDB> {
  if (options?.passphrase !== undefined && options.passphrase.length === 0) {
    throw new Error('TalaDB encryption passphrase must not be empty');
  }
  let resolvedConfig: TalaDbConfig | undefined;
  if (options?.config !== undefined) {
    validateConfig(options.config);
    resolvedConfig = options.config;
  } else {
    resolvedConfig = await loadConfig(options?.configPath);
  }

  const platform = detectPlatform();
  switch (platform) {
    case 'browser':
      // Browser encryption is applied inside the OPFS worker (AES-GCM-256, salt
      // in an OPFS sidecar). The worker fails closed if OPFS is unavailable, so
      // an encrypted DB is never silently downgraded to a plaintext fallback.
      return createBrowserDB(dbName, resolvedConfig, options?.passphrase);
    case 'react-native':
      if (options?.passphrase !== undefined) {
        throw new Error('On React Native, pass the passphrase in the config JSON to TalaDBModule.initialize(); refusing to assume the already-open native database is encrypted');
      }
      return createNativeDB(dbName);
    case 'node':         return createNodeDB(dbName, resolvedConfig, options?.passphrase);
  }
}
