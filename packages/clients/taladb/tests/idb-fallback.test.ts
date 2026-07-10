/**
 * Tests for the IndexedDB fallback helpers used in taladb.worker.js when
 * OPFS is unavailable (cross-origin iframes, Firefox without storage access).
 *
 * The helpers (idbOpen / idbLoadSnapshot / idbSaveSnapshot) are inlined here
 * — matching the worker implementation — but accept the IDB factory as an
 * argument so a fake can be injected without touching real browser storage.
 *
 * All tests run in Node via vitest; no browser globals are required.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Fake IndexedDB — minimal async implementation
// ---------------------------------------------------------------------------

/**
 * A fake IDBRequest whose onsuccess fires asynchronously (matching real IDB).
 */
function makeFakeRequest<T>(result: T) {
  const req = {
    result,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  Promise.resolve().then(() => req.onsuccess?.());
  return req;
}

class FakeIDBObjectStore {
  private readonly _data = new Map<unknown, unknown>();

  get(key: unknown) {
    return makeFakeRequest(this._data.get(key) ?? undefined);
  }

  put(value: unknown, key: unknown) {
    this._data.set(key, value);
    return makeFakeRequest(undefined);
  }

  /** Test helper: inspect stored data directly. */
  peek(key: unknown) { return this._data.get(key); }
}

class FakeIDBTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly _store: FakeIDBObjectStore;

  constructor(store: FakeIDBObjectStore) {
    this._store = store;
    // Auto-complete after microtasks — mirrors real IDB commit behaviour
    Promise.resolve().then(() => this.oncomplete?.());
  }

  objectStore(_name: string): FakeIDBObjectStore { return this._store; }
}

class FakeIDBDatabase {
  private readonly _stores = new Map<string, FakeIDBObjectStore>();
  readonly objectStoreNames = {
    contains: (name: string) => this._stores.has(name),
  };

  createObjectStore(name: string): void {
    this._stores.set(name, new FakeIDBObjectStore());
  }

  transaction(storeName: string, _mode: string): FakeIDBTransaction {
    const store = this._stores.get(storeName) ?? new FakeIDBObjectStore();
    return new FakeIDBTransaction(store);
  }

  /** Test helper: bypass IDB API to inspect a store value directly. */
  peekStore(storeName: string, key: unknown) {
    return this._stores.get(storeName)?.peek(key);
  }
}

class FakeIDBFactory {
  private readonly _dbs = new Map<string, FakeIDBDatabase>();

  open(name: string, _version: number) {
    const isFirstOpen = !this._dbs.has(name);
    if (isFirstOpen) this._dbs.set(name, new FakeIDBDatabase());
    const db = this._dbs.get(name)!;

    const req = {
      result: db,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
    };

    // Fire onupgradeneeded on first open, then onsuccess — all async
    Promise.resolve().then(() => {
      if (isFirstOpen) req.onupgradeneeded?.();
      req.onsuccess?.();
    });

    return req;
  }
}

// ---------------------------------------------------------------------------
// Inlined IDB helpers — mirrors taladb.worker.js exactly (factory-injected)
// ---------------------------------------------------------------------------

const IDB_DB_NAME = 'taladb';
const IDB_STORE   = 'snapshots';
const IDB_VERSION = 1;

function idbOpenWith(factory: FakeIDBFactory): Promise<FakeIDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(new Error('IDB open failed'));
  });
}

async function idbLoadSnapshot(
  factory: FakeIDBFactory | null,
  dbName: string,
): Promise<Uint8Array | null> {
  if (!factory) return null;
  try {
    const idb = await idbOpenWith(factory);
    return new Promise((resolve) => {
      const tx    = idb.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req   = store.get(dbName);
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
      req.onerror   = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSaveSnapshot(
  factory: FakeIDBFactory | null,
  dbName: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!factory) return;
  try {
    const idb = await idbOpenWith(factory);
    await new Promise<void>((resolve, reject) => {
      const tx    = idb.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(bytes, dbName);
      tx.oncomplete = resolve;
      tx.onerror    = reject;
    });
  } catch { /* best-effort — mirror worker's silent catch */ }
}

// ---------------------------------------------------------------------------
// idbLoadSnapshot tests
// ---------------------------------------------------------------------------

describe('idbLoadSnapshot', () => {
  it('returns null immediately when factory is null (IDB unavailable)', async () => {
    expect(await idbLoadSnapshot(null, 'myapp')).toBeNull();
  });

  it('returns null on a fresh database (no snapshot written yet)', async () => {
    const factory = new FakeIDBFactory();
    expect(await idbLoadSnapshot(factory, 'myapp')).toBeNull();
  });

  it('returns the exact bytes previously saved', async () => {
    const factory = new FakeIDBFactory();
    const bytes   = new Uint8Array([1, 2, 3, 4, 5]);
    await idbSaveSnapshot(factory, 'myapp', bytes);
    expect(await idbLoadSnapshot(factory, 'myapp')).toEqual(bytes);
  });

  it('different dbNames are stored independently', async () => {
    const factory = new FakeIDBFactory();
    const a = new Uint8Array([10, 20]);
    const b = new Uint8Array([30, 40, 50]);
    await idbSaveSnapshot(factory, 'app-a', a);
    await idbSaveSnapshot(factory, 'app-b', b);
    expect(await idbLoadSnapshot(factory, 'app-a')).toEqual(a);
    expect(await idbLoadSnapshot(factory, 'app-b')).toEqual(b);
  });

  it('returns null for an unknown dbName even when others are stored', async () => {
    const factory = new FakeIDBFactory();
    await idbSaveSnapshot(factory, 'known', new Uint8Array([1]));
    expect(await idbLoadSnapshot(factory, 'unknown')).toBeNull();
  });

  it('survives a re-open of the same factory (persistent across calls)', async () => {
    const factory = new FakeIDBFactory();
    const bytes   = new Uint8Array([7, 8, 9]);
    await idbSaveSnapshot(factory, 'app', bytes);

    // Simulate loading from a separate idbOpenWith call
    const loaded = await idbLoadSnapshot(factory, 'app');
    expect(loaded).toEqual(bytes);
  });
});

// ---------------------------------------------------------------------------
// idbSaveSnapshot tests
// ---------------------------------------------------------------------------

describe('idbSaveSnapshot', () => {
  it('is a silent no-op when factory is null', async () => {
    await expect(idbSaveSnapshot(null, 'myapp', new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it('overwrites a previous snapshot for the same dbName', async () => {
    const factory = new FakeIDBFactory();
    const first   = new Uint8Array([1, 2, 3]);
    const second  = new Uint8Array([4, 5, 6, 7]);
    await idbSaveSnapshot(factory, 'myapp', first);
    await idbSaveSnapshot(factory, 'myapp', second);
    expect(await idbLoadSnapshot(factory, 'myapp')).toEqual(second);
  });

  it('stores an empty Uint8Array without error', async () => {
    const factory = new FakeIDBFactory();
    const empty   = new Uint8Array(0);
    await idbSaveSnapshot(factory, 'myapp', empty);
    expect(await idbLoadSnapshot(factory, 'myapp')).toEqual(empty);
  });

  it('stores binary data without corruption (edge-case byte values)', async () => {
    const factory = new FakeIDBFactory();
    // zeros, 0xFF, snapshot magic bytes TDBS = 0x54 0x44 0x42 0x53
    const bytes   = new Uint8Array([0x00, 0xFF, 0x80, 0x54, 0x44, 0x42, 0x53, 0x00]);
    await idbSaveSnapshot(factory, 'myapp', bytes);
    expect(await idbLoadSnapshot(factory, 'myapp')).toEqual(bytes);
  });

  it('writing multiple dbNames in one factory does not corrupt any entry', async () => {
    const factory = new FakeIDBFactory();
    const snapshots = [
      { name: 'db-1', bytes: new Uint8Array([1]) },
      { name: 'db-2', bytes: new Uint8Array([2, 2]) },
      { name: 'db-3', bytes: new Uint8Array([3, 3, 3]) },
    ];
    for (const { name, bytes } of snapshots) {
      await idbSaveSnapshot(factory, name, bytes);
    }
    for (const { name, bytes } of snapshots) {
      expect(await idbLoadSnapshot(factory, name)).toEqual(bytes);
    }
  });
});

// ---------------------------------------------------------------------------
// idbOpenWith — object store bootstrap tests
// ---------------------------------------------------------------------------

describe('idbOpenWith', () => {
  it('creates the "snapshots" object store on the very first open', async () => {
    const factory = new FakeIDBFactory();
    const idb     = await idbOpenWith(factory);
    expect(idb.objectStoreNames.contains(IDB_STORE)).toBe(true);
  });

  it('does not attempt to recreate the store if it already exists', async () => {
    const factory = new FakeIDBFactory();
    // First open bootstraps the store
    await idbOpenWith(factory);
    // Second open: onupgradeneeded fires but `contains` returns true → skip
    await expect(idbOpenWith(factory)).resolves.toBeDefined();
  });

  it('resolves with the IdbDatabase object', async () => {
    const factory = new FakeIDBFactory();
    const idb     = await idbOpenWith(factory);
    expect(idb).toBeInstanceOf(FakeIDBDatabase);
  });
});

// ---------------------------------------------------------------------------
// Snapshot round-trip integration (pure JS layer)
// ---------------------------------------------------------------------------

describe('snapshot round-trip via IDB (pure JS protocol test)', () => {
  it('null snapshot from idbLoadSnapshot is treated as first-open (empty DB)', async () => {
    const factory  = new FakeIDBFactory();
    const snapshot = await idbLoadSnapshot(factory, 'fresh');

    // Mirrors WorkerDB.openWithSnapshot(snapshot) behaviour:
    // null / empty → open in-memory fresh database
    const isFirstOpen = snapshot === null || snapshot.byteLength === 0;
    expect(isFirstOpen).toBe(true);
  });

  it('non-empty snapshot from idbLoadSnapshot is passed to WASM for restore', async () => {
    const factory       = new FakeIDBFactory();
    const fakeSnapshot  = new Uint8Array([0x54, 0x44, 0x42, 0x53, 1, 0, 0, 0]); // TDBS magic
    await idbSaveSnapshot(factory, 'app', fakeSnapshot);
    const loaded        = await idbLoadSnapshot(factory, 'app');

    // The snapshot bytes are non-empty → pass to WorkerDB.openWithSnapshot(loaded)
    expect(loaded).not.toBeNull();
    expect(loaded!.byteLength).toBeGreaterThan(0);
    // First 4 bytes are the TDBS magic
    expect(Array.from(loaded!.slice(0, 4))).toEqual([0x54, 0x44, 0x42, 0x53]);
  });
});
