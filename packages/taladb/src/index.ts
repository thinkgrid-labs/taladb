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
// Browser adapter (wraps taladb-wasm)
// ============================================================

async function createBrowserDB(dbName: string): Promise<ZeroDB> {
  const {
    TalaDBWasm,
    is_opfs_available,
    opfs_load_snapshot,
  } = await import('taladb-wasm');

  // Prefer OPFS persistence; fall back to pure in-memory
  const opfsAvailable = await is_opfs_available();
  let snapshot: Uint8Array | undefined;
  if (opfsAvailable) {
    snapshot = (await opfs_load_snapshot(dbName)) ?? undefined;
  }

  const db = opfsAvailable
    ? TalaDBWasm.openWithSnapshot(snapshot ?? null)
    : TalaDBWasm.openInMemory();

  // After every mutating operation we flush a snapshot to OPFS
  async function flush() {
    if (!opfsAvailable) return;
    // Snapshot export is a future enhancement — placeholder for now
    // await opfs_flush_snapshot(dbName, db.snapshot());
  }

  function wrapCollection<T extends Document>(name: string): Collection<T> {
    const col = db.collection(name);
    return {
      insert: async (doc) => { const id = col.insert(doc as any); await flush(); return id; },
      insertMany: async (docs) => { const ids = col.insertMany(docs as any); await flush(); return ids; },
      find: async (filter?) => col.find(filter ?? null) as T[],
      findOne: async (filter) => col.findOne(filter) as T | null,
      updateOne: async (filter, update) => { const r = col.updateOne(filter, update); await flush(); return r; },
      updateMany: async (filter, update) => { const r = col.updateMany(filter, update); await flush(); return r; },
      deleteOne: async (filter) => { const r = col.deleteOne(filter); await flush(); return r; },
      deleteMany: async (filter) => { const r = col.deleteMany(filter); await flush(); return r; },
      count: async (filter?) => col.count(filter ?? null),
      createIndex: async (field) => col.createIndex(field),
      dropIndex: async (field) => col.dropIndex(field),
    };
  }

  return {
    collection: <T extends Document>(name: string) => wrapCollection<T>(name),
    close: async () => { await flush(); },
  };
}

// ============================================================
// Node.js adapter (wraps taladb-node native module)
// ============================================================

async function createNodeDB(dbName: string): Promise<ZeroDB> {
  // taladb-node ships platform-specific .node binaries
  const { TalaDBNode } = await import('taladb-node');
  const db = TalaDBNode.openInMemory(); // or TalaDBNode.open(dbName) for file-backed

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
// React Native adapter (wraps JSI HostObject installed by taladb-react-native)
// ============================================================

async function createNativeDB(dbName: string): Promise<ZeroDB> {
  // The JSI HostObject is installed by taladb-react-native's TurboModule
  // at app startup via ZeroDBModule.initialize(dbName).
  // After that, it is available at globalThis.__TalaDB__.
  const native = (globalThis as any).__TalaDB__;
  if (!native) {
    throw new Error(
      'taladb-react-native JSI HostObject not found. ' +
      'Did you call TalaDBModule.initialize() in your app entry point?'
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
export async function openDB(dbName = 'taladb.db'): Promise<ZeroDB> {
  const platform = detectPlatform();
  switch (platform) {
    case 'browser':      return createBrowserDB(dbName);
    case 'react-native': return createNativeDB(dbName);
    case 'node':         return createNodeDB(dbName);
  }
}
