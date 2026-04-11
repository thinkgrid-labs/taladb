/**
 * TalaDB Worker
 *
 * Runs as a Dedicated Worker. Each tab spawns its own worker instance.
 * Multi-tab write safety is provided by the Web Locks API — only one worker
 * holds the exclusive lock on the OPFS file at a time. Other workers queue up
 * and acquire the lock automatically when the current holder closes.
 *
 * Why DedicatedWorker (not SharedWorker)?
 * ----------------------------------------
 * createSyncAccessHandle() — required for synchronous OPFS I/O — is only
 * available in DedicatedWorkerGlobalScope per the WHATWG File System spec.
 * SharedWorker cannot call it; Chrome throws "is not a function".
 *
 * Why Web Locks?
 * --------------
 * Without coordination, two tabs opening the same OPFS file would race.
 * navigator.locks.request() gives us an exclusive named lock. The first tab
 * acquires it immediately; subsequent tabs block until the holder's worker is
 * terminated (tab closed / navigated) or db.close() is called explicitly.
 * If Web Locks is unavailable the worker opens the file directly and logs a
 * warning (safe for single-tab use).
 *
 * Message protocol
 * ----------------
 * Request  → { id: number, op: string, ...args }
 * Response → { id: number, result: unknown }
 *          | { id: number, error: string }
 *
 * Supported ops
 * -------------
 * init          { dbName }
 * insert        { collection, docJson }
 * insertMany    { collection, docsJson }
 * find          { collection, filterJson }
 * findOne       { collection, filterJson }
 * updateOne     { collection, filterJson, updateJson }
 * updateMany    { collection, filterJson, updateJson }
 * deleteOne     { collection, filterJson }
 * deleteMany    { collection, filterJson }
 * count         { collection, filterJson }
 * createIndex   { collection, field }
 * dropIndex     { collection, field }
 * createFtsIndex    { collection, field }
 * dropFtsIndex      { collection, field }
 * listIndexes       { collection }  → JSON { btree, fts, vector }
 * createVectorIndex { collection, field, dimensions, metric?, indexType?, hnswM?, hnswEfConstruction? }
 * dropVectorIndex   { collection, field }
 * upgradeVectorIndex { collection, field }
 * findNearest       { collection, field, queryJson, topK, filterJson? }
 * close             {}
 *
 * Multi-tab live queries (BroadcastChannel)
 * -----------------------------------------
 * When a write op (insert/insertMany/updateOne/updateMany/deleteOne/deleteMany) commits, the worker
 * posts a `"taladb:changed"` message on a BroadcastChannel named
 * `"taladb:<dbName>"`.  Other tabs listening on the same channel re-trigger
 * their active `subscribe()` pollers immediately, bypassing the 300 ms tick.
 *
 * IndexedDB fallback (no OPFS)
 * ----------------------------
 * When OPFS is unavailable (cross-origin iframes, Firefox without storage
 * access) the worker opens an in-memory database seeded from the last snapshot
 * stored in IndexedDB.  After every write it flushes a new snapshot back to
 * IndexedDB so data survives page reloads.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('../pkg/taladb_web').WorkerDB | null} */
let db = null;

/**
 * WorkerDB constructor — hoisted to module scope so snapshot reloads in
 * IDB-fallback mode can call WorkerDB.openWithSnapshot without re-importing.
 * @type {typeof import('../pkg/taladb_web').WorkerDB | null}
 */
let WorkerDB = null;

/**
 * Set to true by the BroadcastChannel listener (fallback mode) when the
 * primary tab commits a write. Cleared at the start of the next dispatch.
 * @type {boolean}
 */
let snapshotDirty = false;

/**
 * Resolve function set when a fallback tab is waiting for the primary tab to
 * export a snapshot via BroadcastChannel. Cleared once resolved or timed out.
 * @type {(() => void) | null}
 */
let pendingSnapshotResolve = null;

/**
 * Deduplicates concurrent init calls for the same dbName within one worker.
 * @type {Map<string, Promise<void>>}
 */
const initPromises = new Map();

/** The dbName that was successfully initialised (or is being initialised). */
let activeDbName = null;

const isDev = typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
const log = isDev ? console.log.bind(console, '[TalaDB Worker]') : () => {};
const warn = isDev ? console.warn.bind(console, '[TalaDB Worker]') : () => {};

/**
 * Resolving this releases the Web Lock and closes the sync handle.
 * Set inside doInit; called by the 'close' op or when the worker terminates.
 * @type {(() => void) | null}
 */
let releaseLock = null;

/**
 * BroadcastChannel used to notify sibling tabs of writes.
 * Created in doInit; null until the channel name is known.
 * @type {BroadcastChannel | null}
 */
let broadcastChannel = null;

/**
 * True when running in IDB-fallback mode (OPFS unavailable).
 * In this mode every write flushes a snapshot back to IndexedDB.
 * @type {boolean}
 */
let idbFallback = false;

// ---------------------------------------------------------------------------
// IndexedDB helpers (used only when OPFS is unavailable)
// ---------------------------------------------------------------------------

const IDB_DB_NAME = 'taladb';
const IDB_STORE = 'snapshots';
const IDB_VERSION = 1;

/** Open (or upgrade) the "taladb" IDB database and return the IDBDatabase. */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = self.indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      // Create the object store the very first time.
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Load a snapshot Uint8Array from IndexedDB for `dbName`.
 * Returns null if no snapshot is stored yet.
 * @param {string} dbName
 * @returns {Promise<Uint8Array | null>}
 */
async function idbLoadSnapshot(dbName) {
  if (!self.indexedDB) return null;
  try {
    const idb = await idbOpen();
    return new Promise((resolve) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(dbName);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Persist a snapshot Uint8Array to IndexedDB for `dbName` (fire-and-forget).
 * @param {string} dbName
 * @param {Uint8Array} bytes
 */
async function idbSaveSnapshot(dbName, bytes) {
  if (!self.indexedDB) return;
  try {
    const idb = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, dbName);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  } catch { /* best-effort persistence — ignore failures */ }
}

/**
 * Notify sibling tabs of a write and, when in IDB-fallback mode, flush the
 * updated snapshot to IndexedDB.  Must be called after every mutating op.
 */
function onWriteCommitted() {
  broadcastChannel?.postMessage('taladb:changed');
  // Always flush a snapshot to IDB after every write — this keeps other tabs'
  // IDB-fallback instances in sync via BroadcastChannel + snapshotDirty reload.
  if (db && activeDbName) {
    try {
      const bytes = db.exportSnapshot();
      idbSaveSnapshot(activeDbName, bytes).catch(() => {});
    } catch { /* ignore snapshot export errors */ }
  }
}

// ---------------------------------------------------------------------------
// Dedicated Worker message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e) => {
  const { id, op, ...args } = e.data;
  try {
    const result = await dispatch(op, args);
    self.postMessage({ id, result: result ?? null });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatch(op, args) {
  // In IDB-fallback mode, reload the snapshot before each op when the primary
  // tab has signalled a write via BroadcastChannel. This keeps reads fresh.
  if (idbFallback && snapshotDirty && op !== 'init' && db && activeDbName && WorkerDB) {
    snapshotDirty = false;
    try {
      const fresh = await idbLoadSnapshot(activeDbName);
      if (fresh) db = WorkerDB.openWithSnapshot(fresh);
    } catch { /* ignore reload errors — stale read is acceptable */ }
  }

  if (op === 'init') {
    const { dbName } = args;

    if (activeDbName !== null && activeDbName !== dbName) {
      throw new Error(
        `TalaDB worker already initialised for "${activeDbName}". ` +
        `Cannot open "${dbName}" in the same worker instance.`
      );
    }

    if (!initPromises.has(dbName)) {
      activeDbName = dbName;
      initPromises.set(dbName, doInit(dbName));
    }
    await initPromises.get(dbName);
    return null;
  }

  if (!db) throw new Error('TalaDB worker not initialised — call init first');

  switch (op) {
    case 'insert': {
      const result = db.insert(args.collection, args.docJson);
      onWriteCommitted();
      return result;
    }

    case 'insertMany': {
      const result = db.insertMany(args.collection, args.docsJson);
      onWriteCommitted();
      return result;
    }

    case 'find':
      return db.find(args.collection, args.filterJson ?? 'null');

    case 'findOne':
      return db.findOne(args.collection, args.filterJson ?? 'null');

    case 'updateOne': {
      const result = db.updateOne(args.collection, args.filterJson, args.updateJson);
      onWriteCommitted();
      return result;
    }

    case 'updateMany': {
      const result = db.updateMany(args.collection, args.filterJson, args.updateJson);
      onWriteCommitted();
      return result;
    }

    case 'deleteOne': {
      const result = db.deleteOne(args.collection, args.filterJson);
      onWriteCommitted();
      return result;
    }

    case 'deleteMany': {
      const result = db.deleteMany(args.collection, args.filterJson);
      onWriteCommitted();
      return result;
    }

    case 'count':
      return db.count(args.collection, args.filterJson ?? 'null');

    case 'createIndex':
      db.createIndex(args.collection, args.field);
      return null;

    case 'dropIndex':
      db.dropIndex(args.collection, args.field);
      return null;

    case 'createFtsIndex':
      db.createFtsIndex(args.collection, args.field);
      return null;

    case 'dropFtsIndex':
      db.dropFtsIndex(args.collection, args.field);
      return null;

    case 'listIndexes':
      return db.listIndexes(args.collection);

    case 'createVectorIndex':
      db.createVectorIndex(
        args.collection,
        args.field,
        args.dimensions,
        args.metric ?? null,
        args.indexType ?? null,
        args.hnswM ?? null,
        args.hnswEfConstruction ?? null,
      );
      return null;

    case 'dropVectorIndex':
      db.dropVectorIndex(args.collection, args.field);
      return null;

    case 'upgradeVectorIndex':
      db.upgradeVectorIndex(args.collection, args.field);
      return null;

    case 'findNearest':
      return db.findNearest(
        args.collection,
        args.field,
        args.queryJson,
        args.topK,
        args.filterJson ?? 'null',
      );

    case 'close':
      // Release the Web Lock and close the sync handle gracefully.
      if (releaseLock) { releaseLock(); releaseLock = null; }
      broadcastChannel?.close();
      broadcastChannel = null;
      idbFallback = false;
      db = null;
      return null;

    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Initialisation — load WASM, acquire lock, open OPFS file
// ---------------------------------------------------------------------------

async function doInit(dbName) {
  const wasm = await import('../pkg/taladb_web.js');
  await wasm.default();

  // Hoist to module scope so snapshot reloads in dispatch() can use it.
  WorkerDB = wasm.WorkerDB;

  // Open the BroadcastChannel now that we know the db name.
  if (typeof BroadcastChannel !== 'undefined') {
    broadcastChannel = new BroadcastChannel(`taladb:${dbName}`);
    broadcastChannel.onmessage = async (e) => {
      if (e.data === 'taladb:changed' && idbFallback) {
        // Fallback tab: primary tab wrote — reload snapshot before next read.
        snapshotDirty = true;
      } else if (e.data === 'taladb:request-snapshot' && !idbFallback && db && activeDbName) {
        // Primary (OPFS) tab: a new tab asked for a snapshot — export and save it.
        try {
          const bytes = db.exportSnapshot();
          await idbSaveSnapshot(activeDbName, bytes);
          broadcastChannel.postMessage('taladb:snapshot-ready');
          log('Exported snapshot for waiting tab');
        } catch { /* ignore */ }
      } else if (e.data === 'taladb:snapshot-ready' && pendingSnapshotResolve) {
        // Fallback tab: primary tab finished saving — wake up the waiting doInit.
        const resolve = pendingSnapshotResolve;
        pendingSnapshotResolve = null;
        resolve();
      }
    };
    log('BroadcastChannel opened:', `taladb:${dbName}`);
  }

  const opfsAvailable = await checkOpfs();
  if (!opfsAvailable) {
    warn('OPFS unavailable — falling back to IndexedDB-backed in-memory');
    const snapshot = await idbLoadSnapshot(dbName);
    db = WorkerDB.openWithSnapshot(snapshot);
    idbFallback = true;
    if (snapshot) {
      log(`Restored from IndexedDB snapshot (${snapshot.byteLength} bytes)`);
    } else {
      log('New in-memory database — writes will be persisted to IndexedDB');
    }
    return;
  }

  const root = await navigator.storage.getDirectory();
  const fileName = `taladb_${dbName.replaceAll(/[/\\:]/g, '_')}.redb`;
  const fileHandle = await root.getFileHandle(fileName, { create: true });

  if (!('locks' in navigator)) {
    // Web Locks not available — open directly (single-tab safe only).
    warn('Web Locks unavailable — multi-tab write safety disabled');
    const syncHandle = await fileHandle.createSyncAccessHandle();
    db = WorkerDB.openWithOpfs(syncHandle);
    log(`Opened "${fileName}" via OPFS`);
    return;
  }

  // Try to acquire the exclusive OPFS lock immediately (ifAvailable).
  // If another tab already holds it, fall back to IDB snapshot right away so
  // this tab is immediately usable instead of blocking until the other tab closes.
  // The primary (OPFS) tab flushes a snapshot to IDB after every write, and
  // this tab's BroadcastChannel listener sets snapshotDirty so dispatch()
  // reloads the snapshot before the next read — keeping data fresh across tabs.
  const lockName = `taladb:${fileName}`;
  await new Promise((resolve, reject) => {
    navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (lock === null) {
        // Lock is held by another tab — use IDB snapshot so this tab loads immediately.
        warn('OPFS lock held by another tab — falling back to IndexedDB snapshot (live-sync via BroadcastChannel)');
        let snapshot = await idbLoadSnapshot(dbName);

        if (!snapshot && broadcastChannel) {
          // No IDB snapshot yet — ask the primary tab to export one now.
          log('No IDB snapshot — requesting one from the primary tab...');
          const gotIt = await new Promise(res => {
            pendingSnapshotResolve = res;
            setTimeout(() => { pendingSnapshotResolve = null; res(false); }, 2000);
            broadcastChannel.postMessage('taladb:request-snapshot');
          });
          if (gotIt !== false) snapshot = await idbLoadSnapshot(dbName);
        }

        db = WorkerDB.openWithSnapshot(snapshot ?? null);
        idbFallback = true;
        if (snapshot) {
          log(`Restored from IDB snapshot (${snapshot.byteLength} bytes)`);
        } else {
          log('No IDB snapshot yet — starting with empty in-memory database');
        }
        resolve();
        return; // Do not hold the lock; returning releases it back to the queue.
      }

      // Acquired the lock — use OPFS.
      try {
        const syncHandle = await fileHandle.createSyncAccessHandle();
        db = WorkerDB.openWithOpfs(syncHandle);
        log(`Opened "${fileName}" via OPFS (Web Locks)`);
        resolve(); // signal doInit complete — caller can proceed

        // Hold the lock by keeping this async callback alive.
        // Resolved by the 'close' op or when the worker is terminated.
        await new Promise(res => { releaseLock = res; });

        syncHandle.close();
        db = null;
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// OPFS capability probe
// ---------------------------------------------------------------------------

async function checkOpfs() {
  try {
    const root = await navigator.storage.getDirectory();
    // Probe createSyncAccessHandle — only available in Dedicated Workers.
    // getDirectory() succeeding alone is not sufficient.
    // Use a unique filename so concurrent workers don't collide on the same
    // probe file (each createSyncAccessHandle is exclusive).
    const probeName = `_taladb_probe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const probe = await root.getFileHandle(probeName, { create: true });
    if (typeof probe.createSyncAccessHandle !== 'function') return false;
    const handle = await probe.createSyncAccessHandle();
    handle.close();
    await root.removeEntry(probeName);
    return true;
  } catch {
    return false;
  }
}
