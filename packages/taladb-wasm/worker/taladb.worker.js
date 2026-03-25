/**
 * TalaDB SharedWorker
 *
 * Owns the OPFS file handle and the WASM + redb database instance.
 * The main thread connects via SharedWorker and communicates through
 * a typed message protocol.
 *
 * Why SharedWorker (not DedicatedWorker)?
 * ----------------------------------------
 * A SharedWorker persists as long as any tab/page from the same origin
 * has it open. This means multiple tabs share the same database instance —
 * no write conflicts, no duplicate open files.
 *
 * Message protocol
 * ----------------
 * Request  → { id: number, op: string, ...args }
 * Response → { id: number, result: unknown }
 *          | { id: number, error: string }
 *
 * The `id` field lets the main thread match async responses to pending
 * Promise resolvers even when operations complete out of order.
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
 * createFtsIndex { collection, field }
 * dropFtsIndex  { collection, field }
 * close         {}
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('../pkg/taladb_wasm').WorkerDB | null} */
let db = null;

/**
 * Maps dbName → Promise<void> so that:
 * - Concurrent init calls for the same dbName share one promise (deduplicated).
 * - Init calls for different dbNames are rejected after the first succeeds,
 *   because a SharedWorker instance owns exactly one database file.
 * @type {Map<string, Promise<void>>}
 */
const initPromises = new Map();

/** The dbName that was successfully initialised (or is being initialised). */
let activeDbName = null;

// ---------------------------------------------------------------------------
// SharedWorker connect handler
// ---------------------------------------------------------------------------

self.onconnect = (connectEvent) => {
  const port = connectEvent.ports[0];

  port.onmessage = async (e) => {
    const { id, op, ...args } = e.data;
    try {
      const result = await dispatch(op, args);
      port.postMessage({ id, result: result ?? null });
    } catch (err) {
      port.postMessage({ id, error: String(err?.message ?? err) });
    }
  };

  port.start();
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatch(op, args) {
  if (op === 'init') {
    const { dbName } = args;

    // Reject if a different database was already opened in this worker instance.
    // A SharedWorker owns exactly one OPFS file handle.
    if (activeDbName !== null && activeDbName !== dbName) {
      throw new Error(
        `TalaDB worker already initialised for "${activeDbName}". ` +
        `Cannot open "${dbName}" in the same SharedWorker instance.`
      );
    }

    // Deduplicate concurrent init calls for the same dbName.
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

    case 'close':
      db = null;
      return null;

    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Initialisation — load WASM, open OPFS file, create WorkerDB
// ---------------------------------------------------------------------------

async function doInit(dbName) {
  // Dynamic import of the WASM module (wasm-pack --target web output)
  // The bundler (Vite/Webpack) will resolve this path correctly.
  const wasm = await import('../pkg/taladb_wasm.js');
  await wasm.default(); // run wasm-bindgen init (sets up memory, panic hook, etc.)

  const { WorkerDB } = wasm;

  const opfsAvailable = await checkOpfs();
  if (!opfsAvailable) {
    console.warn('[TalaDB Worker] OPFS unavailable — falling back to in-memory');
    db = WorkerDB.openInMemory();
    return;
  }

  // Get the OPFS root directory
  const root = await navigator.storage.getDirectory();

  // Open (or create) the database file
  const fileName = `taladb_${dbName.replaceAll(/[/\\:]/g, '_')}.redb`;
  const fileHandle = await root.getFileHandle(fileName, { create: true });

  // createSyncAccessHandle — available in workers only
  const syncHandle = await fileHandle.createSyncAccessHandle();

  db = WorkerDB.openWithOpfs(syncHandle);
  console.log(`[TalaDB Worker] Opened "${fileName}" via OPFS`);
}

async function checkOpfs() {
  try {
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}
