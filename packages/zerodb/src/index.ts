import type { Collection, Document, Filter, Update, Value, ZeroDB } from './types';

export type { Collection, Document, Filter, Update, Value, ZeroDB };

// ============================================================
// Platform detection + dynamic import
// ============================================================

type Platform = 'browser' | 'react-native' | 'node';

function detectPlatform(): Platform {
  // React Native exposes nativeCallSyncHook on the global object
  if (typeof (globalThis as any).nativeCallSyncHook !== 'undefined') {
    return 'react-native';
  }
  // Browser: window + navigator exist
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
    return 'browser';
  }
  return 'node';
}

// ============================================================
// Browser adapter (wraps zerodb-wasm)
// ============================================================

async function createBrowserDB(dbName: string): Promise<ZeroDB> {
  // Dynamically import WASM — bundlers (Vite, Next.js) handle this via ?url or ?init
  const { ZeroDBWasm } = await import('zerodb-wasm');
  const db = ZeroDBWasm.openInMemory(); // TODO: swap for OPFS-backed when ready

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const col = db.collection(name);
    return {
      insert: async (doc) => col.insert(doc as any),
      insertMany: async (docs) => col.insertMany(docs as any),
      find: async (filter?) => col.find(filter ?? null) as T[],
      findOne: async (filter) => col.findOne(filter) as T | null,
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
    close: async () => {
      // in-memory db: nothing to flush
    },
  };
}

// ============================================================
// Node.js adapter (wraps zerodb-node native module)
// ============================================================

async function createNodeDB(dbName: string): Promise<ZeroDB> {
  // zerodb-node ships platform-specific .node binaries
  const { ZeroDBNode } = await import('zerodb-node');
  const db = ZeroDBNode.openInMemory(); // or ZeroDBNode.open(dbName) for file-backed

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const col = db.collection(name);
    return {
      insert: async (doc) => col.insert(doc as any),
      insertMany: async (docs) => col.insertMany(docs as any),
      find: async (filter?) => col.find(filter ?? null) as T[],
      findOne: async (filter) => (col.findOne(filter) ?? null) as T | null,
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
// React Native adapter (wraps JSI HostObject installed by zerodb-react-native)
// ============================================================

async function createNativeDB(dbName: string): Promise<ZeroDB> {
  // The JSI HostObject is installed by zerodb-react-native's TurboModule
  // at app startup via ZeroDBModule.initialize(dbName).
  // After that, it is available at globalThis.__ZeroDB__.
  const native = (globalThis as any).__ZeroDB__;
  if (!native) {
    throw new Error(
      'zerodb-react-native JSI HostObject not found. ' +
      'Did you call ZeroDBModule.initialize() in your app entry point?'
    );
  }

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const col = native.collection(name);
    return {
      insert: async (doc) => col.insert(doc),
      insertMany: async (docs) => col.insertMany(docs),
      find: async (filter?) => col.find(filter ?? {}),
      findOne: async (filter) => col.findOne(filter) ?? null,
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
export async function openDB(dbName = 'zerodb.db'): Promise<ZeroDB> {
  const platform = detectPlatform();
  switch (platform) {
    case 'browser':      return createBrowserDB(dbName);
    case 'react-native': return createNativeDB(dbName);
    case 'node':         return createNodeDB(dbName);
  }
}
