import type { Collection, Document, TalaDB } from './types';
import { loadConfig, validateConfig } from './config';
import type { TalaDbConfig, SyncConfig } from './config';

// Re-export all public types for consumers (export…from satisfies S7763)
export type {
  Collection,
  CollectionIndexInfo,
  Document,
  Filter,
  Update,
  Value,
  TalaDB,
  VectorMetric,
  VectorIndexOptions,
  VectorSearchResult,
} from './types';

export type { TalaDbConfig, SyncConfig } from './config';

// ============================================================
// Platform detection + dynamic import
// ============================================================

type Platform = 'browser' | 'react-native' | 'node';

function detectPlatform(): Platform {
  // React Native exposes nativeCallSyncHook on the global object
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
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ id, op, ...args });
    });
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
): () => void {
  let active = true;
  let lastJson = '';
  const poll = async () => {
    if (!active) return;
    try {
      const docs = await findFn();
      const json = JSON.stringify(docs);
      if (json !== lastJson) {
        lastJson = json;
        callback(docs);
      }
    } catch { /* ignore errors during poll */ }
    if (active) setTimeout(poll, 300);
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

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const col = db.collection(name);
    return {
      insert: async (doc) => col.insert(doc),
      insertMany: async (docs) => col.insertMany(docs),
      find: async (filter?) => col.find(filter ?? null),
      findOne: async (filter) => col.findOne(filter) ?? null,
      updateOne: async (filter, update) => col.updateOne(filter, update),
      updateMany: async (filter, update) => col.updateMany(filter, update),
      deleteOne: async (filter) => col.deleteOne(filter),
      deleteMany: async (filter) => col.deleteMany(filter),
      count: async (filter?) => col.count(filter ?? null),
      createIndex: async (field) => col.createIndex(field),
      dropIndex: async (field) => col.dropIndex(field),
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
      subscribe: (filter, callback) =>
        makePoller(async () => col.find(filter ?? null) as T[], callback),
    };
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: async () => {},
  };
}

async function createBrowserDB(dbName: string): Promise<TalaDB> {
  // createSyncAccessHandle (required for OPFS persistence) is only available
  // in Dedicated Workers per the WHATWG spec — not SharedWorkers. We use a
  // DedicatedWorker so each tab gets its own isolated worker + file handle.
  const workerUrl = new URL('@taladb/web/worker/taladb.worker.js', import.meta.url);
  const worker = new Worker(workerUrl, { type: 'module', name: 'taladb' });
  const proxy = new WorkerProxy(worker);

  // Initialize the worker (opens OPFS file or falls back to IDB-backed in-memory)
  await proxy.send('init', { dbName });

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

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const s = JSON.stringify;
    return {
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

      createIndex: (field) =>
        proxy.send<void>('createIndex', { collection: name, field }),

      dropIndex: (field) =>
        proxy.send<void>('dropIndex', { collection: name, field }),

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

      subscribe: (filter, callback) => {
        let active = true;
        let lastJson = '[]';
        let timer: ReturnType<typeof setTimeout> | null = null;

        const poll = async () => {
          if (!active) return;
          // Cancel any pending tick — we're running now (either nudged or ticked).
          if (timer !== null) { clearTimeout(timer); timer = null; }
          try {
            const json = await proxy.send<string>('find', {
              collection: name, filterJson: filter ? s(filter) : 'null',
            });
            if (json !== lastJson) {
              lastJson = json;
              callback(JSON.parse(json) as T[]);
            }
          } catch { /* ignore errors during poll */ }
          // Schedule the next polling tick (fallback when BroadcastChannel
          // is unavailable or for same-tab writes).
          if (active) timer = setTimeout(poll, 300);
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
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: async () => {
      channel?.close();
      await proxy.send<void>('close');
      worker.terminate();
    },
  };
}

// ============================================================
// Node.js adapter (wraps @taladb/node native module)
// ============================================================

async function createNodeDB(dbName: string): Promise<TalaDB> {
  // @taladb/node ships platform-specific .node binaries
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — types generated by `napi build`; not available until package is built
  const { TalaDBNode } = await import('@taladb/node');
  const db = TalaDBNode.open(dbName);

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const col = db.collection(name);
    return {
      insert: async (doc) => col.insert(doc as Record<string, unknown>),
      insertMany: async (docs) => col.insertMany(docs as Record<string, unknown>[]),
      find: async (filter?) => col.find(filter ?? null),
      findOne: async (filter) => col.findOne(filter) ?? null,
      updateOne: async (filter, update) => col.updateOne(filter, update),
      updateMany: async (filter, update) => col.updateMany(filter, update),
      deleteOne: async (filter) => col.deleteOne(filter),
      deleteMany: async (filter) => col.deleteMany(filter),
      count: async (filter?) => col.count(filter ?? null),
      createIndex: async (field) => col.createIndex(field),
      dropIndex: async (field) => col.dropIndex(field),
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
      subscribe: (filter, callback) =>
        makePoller(async () => col.find(filter ?? null) as T[], callback),
    };
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: async () => {},
  };
}

// ============================================================
// React Native adapter (wraps JSI HostObject installed by @taladb/react-native)
// ============================================================

/** Shape of the JSI HostObject installed by @taladb/react-native. */
interface NativeCollection {
  insert(doc: Record<string, unknown>): string;
  insertMany(docs: Record<string, unknown>[]): string[];
  find(filter: Record<string, unknown>): Record<string, unknown>[];
  findOne(filter: Record<string, unknown>): Record<string, unknown> | null;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): boolean;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): number;
  deleteOne(filter: Record<string, unknown>): boolean;
  deleteMany(filter: Record<string, unknown>): number;
  count(filter: Record<string, unknown>): number;
  createIndex(field: string): void;
  dropIndex(field: string): void;
  createFtsIndex(field: string): void;
  dropFtsIndex(field: string): void;
  createVectorIndex(field: string, dimensions: number, metric: string | null, indexType: string | null, hnswM: number | null, hnswEfConstruction: number | null): void;
  dropVectorIndex(field: string): void;
  upgradeVectorIndex(field: string): void;
  listIndexes(): string;
  findNearest(field: string, query: number[], topK: number, filter: Record<string, unknown> | null): { document: Record<string, unknown>; score: number }[];
}

interface NativeHostObject {
  collection(name: string): NativeCollection;
  close(): void;
}

async function createNativeDB(_dbName: string): Promise<TalaDB> {
  // The JSI HostObject is installed by @taladb/react-native's TurboModule
  // at app startup via TalaDBModule.initialize(dbName).
  // After that, it is available at globalThis.__TalaDB__.
  const maybeNative = (globalThis as Record<string, unknown>).__TalaDB__ as NativeHostObject | undefined;
  if (!maybeNative) {
    throw new Error(
      '@taladb/react-native JSI HostObject not found. ' +
      'Did you call TalaDBModule.initialize() in your app entry point?'
    );
  }
  const native: NativeHostObject = maybeNative;

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const col = native.collection(name);
    return {
      insert: async (doc) => col.insert(doc as Record<string, unknown>),
      insertMany: async (docs) => col.insertMany(docs as Record<string, unknown>[]),
      find: async (filter?) => col.find(filter ?? {}) as T[],
      findOne: async (filter) => col.findOne(filter ?? {}) as T | null,
      updateOne: async (filter, update) => col.updateOne(filter, update),
      updateMany: async (filter, update) => col.updateMany(filter, update),
      deleteOne: async (filter) => col.deleteOne(filter),
      deleteMany: async (filter) => col.deleteMany(filter),
      count: async (filter?) => col.count(filter ?? {}),
      createIndex: async (field) => col.createIndex(field),
      dropIndex: async (field) => col.dropIndex(field),
      createFtsIndex: async (field) => col.createFtsIndex(field),
      dropFtsIndex: async (field) => col.dropFtsIndex(field),
      createVectorIndex: async (field, options) =>
        col.createVectorIndex(field, options.dimensions, options.metric ?? null, options.indexType ?? null, options.hnswM ?? null, options.hnswEfConstruction ?? null),
      dropVectorIndex: async (field) => col.dropVectorIndex(field),
      upgradeVectorIndex: async (field) => col.upgradeVectorIndex(field),
      listIndexes: async () => JSON.parse(col.listIndexes()),
      findNearest: async (field, vector, topK, filter?) => {
        const raw = col.findNearest(field, vector, topK, filter ?? null);
        return raw as { document: T; score: number }[];
      },
      subscribe: (filter, callback) =>
        makePoller(async () => col.find(filter ?? {}) as T[], callback),
    };
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: async () => native.close(),
  };
}

// ============================================================
// Public entry point
// ============================================================

/** Options for `openDB`. */
export interface OpenDBOptions {
  /**
   * Explicit path to a `taladb.config.yml` / `taladb.config.json` file.
   * If omitted, TalaDB auto-discovers the file from `process.cwd()` on Node.js.
   * Ignored on browser and React Native (sync is silently disabled there).
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
  // Phase 1: load + validate config. Not yet used for sync behaviour —
  // the HTTP adapter is wired in Phase 3.
  if (options?.config !== undefined) {
    validateConfig(options.config);
  } else {
    await loadConfig(options?.configPath);
  }

  const platform = detectPlatform();
  switch (platform) {
    case 'browser':      return createBrowserDB(dbName);
    case 'react-native': return createNativeDB(dbName);
    case 'node':         return createNodeDB(dbName);
  }
}
