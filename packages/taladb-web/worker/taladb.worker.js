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
 * createVectorIndex { collection, field, dimensions, metric? }
 * dropVectorIndex   { collection, field }
 * findNearest       { collection, field, queryJson, topK, filterJson? }
 * close             {}
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('../pkg/taladb_web').WorkerDB | null} */
let db = null;

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
    case 'insert':
      return db.insert(args.collection, args.docJson);

    case 'insertMany':
      return db.insertMany(args.collection, args.docsJson);

    case 'find':
      return db.find(args.collection, args.filterJson ?? 'null');

    case 'findOne':
      return db.findOne(args.collection, args.filterJson ?? 'null');

    case 'updateOne':
      return db.updateOne(args.collection, args.filterJson, args.updateJson);

    case 'updateMany':
      return db.updateMany(args.collection, args.filterJson, args.updateJson);

    case 'deleteOne':
      return db.deleteOne(args.collection, args.filterJson);

    case 'deleteMany':
      return db.deleteMany(args.collection, args.filterJson);

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

    case 'createVectorIndex':
      db.createVectorIndex(args.collection, args.field, args.dimensions, args.metric ?? null);
      return null;

    case 'dropVectorIndex':
      db.dropVectorIndex(args.collection, args.field);
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

  const { WorkerDB } = wasm;

  const opfsAvailable = await checkOpfs();
  if (!opfsAvailable) {
    warn('OPFS unavailable — falling back to in-memory');
    db = WorkerDB.openInMemory();
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

  // Acquire an exclusive lock on the database file.
  // If another tab's worker already holds it, this call blocks until that
  // worker calls close() or the tab is terminated (lock auto-released).
  const lockName = `taladb:${fileName}`;
  await new Promise((resolve, reject) => {
    navigator.locks.request(lockName, async () => {
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
