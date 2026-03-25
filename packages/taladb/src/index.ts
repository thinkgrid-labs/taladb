import type { Collection, Document, Filter, Update, Value, ZeroDB } from './types';

export type { Collection, Document, Filter, Update, Value, ZeroDB };

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
class WorkerProxy {
  private readonly port: MessagePort;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(port: MessagePort) {
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
    this.port.start();
  }

  send<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ id, op, ...args });
    });
  }
}

/**
 * In-memory fallback for browsers that don't support SharedWorker (e.g. Safari iOS).
 * Data is not persisted across page reloads; all writes live in WASM memory only.
 */
async function createInMemoryBrowserDB(_dbName: string): Promise<ZeroDB> {
  const wasmUrl = new URL('taladb-wasm/pkg/taladb_wasm.js', import.meta.url);
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
    };
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: async () => {},
  };
}

async function createBrowserDB(dbName: string): Promise<ZeroDB> {
  // SharedWorker is not available in Safari on iOS or in some older browsers.
  // Fall back to an in-memory WASM instance in those environments.
  if (typeof SharedWorker === 'undefined') {
    return createInMemoryBrowserDB(dbName);
  }

  // Resolve the worker URL — bundlers (Vite, Webpack) handle new URL() correctly
  const workerUrl = new URL('taladb-wasm/worker/taladb.worker.js', import.meta.url);
  const worker = new SharedWorker(workerUrl, { type: 'module', name: 'taladb' });
  const proxy = new WorkerProxy(worker.port);

  // Initialize the worker (opens OPFS file or falls back to in-memory)
  await proxy.send('init', { dbName });

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
    };
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: () => proxy.send<void>('close'),
  };
}

// ============================================================
// Node.js adapter (wraps taladb-node native module)
// ============================================================

async function createNodeDB(dbName: string): Promise<ZeroDB> {
  // taladb-node ships platform-specific .node binaries
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — types generated by `napi build`; not available until package is built
  const { TalaDBNode } = await import('taladb-node');
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
    };
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: async () => {},
  };
}

// ============================================================
// React Native adapter (wraps JSI HostObject installed by taladb-react-native)
// ============================================================

/** Shape of the JSI HostObject installed by taladb-react-native. */
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
}

interface NativeHostObject {
  collection(name: string): NativeCollection;
  close(): void;
}

async function createNativeDB(_dbName: string): Promise<ZeroDB> {
  // The JSI HostObject is installed by taladb-react-native's TurboModule
  // at app startup via ZeroDBModule.initialize(dbName).
  // After that, it is available at globalThis.__TalaDB__.
  const maybeNative = (globalThis as Record<string, unknown>).__TalaDB__ as NativeHostObject | undefined;
  if (!maybeNative) {
    throw new Error(
      'taladb-react-native JSI HostObject not found. ' +
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

/**
 * Open a ZeroDB database.
 *
 * @param dbName  Name of the database file (used for OPFS and native file paths).
 *                Ignored for in-memory databases.
 *
 * @example
 * const db = await openDB('myapp.db');
 * const users = db.collection<User>('users');
 * const id = await users.insert({ name: 'Alice', age: 30 });
 */
export async function openDB(dbName = 'taladb.db'): Promise<ZeroDB> {
  const platform = detectPlatform();
  switch (platform) {
    case 'browser':      return createBrowserDB(dbName);
    case 'react-native': return createNativeDB(dbName);
    case 'node':         return createNodeDB(dbName);
  }
}
