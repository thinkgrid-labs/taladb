/**
 * @taladb/cloudflare — TalaDB adapter for Cloudflare Workers.
 *
 * Uses the existing @taladb/web WASM (in-memory mode — no OPFS) and persists
 * state to Durable Objects storage as a binary snapshot.
 *
 * ## Architecture
 *
 * Each Durable Object instance holds one TalaDB database in WASM memory.
 * On every mutating request the snapshot is flushed to Durable Objects
 * `storage.put()`. When the DO hibernates and wakes up, `init()` restores the
 * database from the last saved snapshot via `storage.get()`.
 *
 * ## Usage
 *
 * ```ts
 * import { TalaDBDurableObject, openDurableDB } from '@taladb/cloudflare';
 * import { WorkerDB } from '@taladb/web/pkg/taladb_web.js';
 *
 * export class MyDB extends TalaDBDurableObject {}
 *
 * export default {
 *   async fetch(request, env) {
 *     const id = env.MY_DB.idFromName('default');
 *     const stub = env.MY_DB.get(id);
 *     return stub.fetch(request);
 *   }
 * };
 * ```
 *
 * Or use `openDurableDB` inside a Durable Object's `fetch` method to get a
 * full TalaDB-compatible API object:
 *
 * ```ts
 * const db = await openDurableDB(this.storage);
 * const users = db.collection('users');
 * await users.insert({ name: 'Alice' });
 * await db.flush(); // persist snapshot to DO storage
 * await db.compact();
 * ```
 */

// ---------------------------------------------------------------------------
// WASM lazy loader — import once per Worker isolate lifetime
// ---------------------------------------------------------------------------

/** @type {import('../../../taladb-web/pkg/taladb_web.js').WorkerDB | null} */
let WorkerDBClass = null;
let wasmInitPromise = null;

async function loadWasm() {
  if (WorkerDBClass) return WorkerDBClass;
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    const wasm = await import('@taladb/web/pkg/taladb_web.js');
    await wasm.default();
    WorkerDBClass = wasm.WorkerDB;
    return WorkerDBClass;
  })();

  return wasmInitPromise;
}

// ---------------------------------------------------------------------------
// Snapshot persistence key used in Durable Objects storage
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = '__taladb_snapshot__';

// ---------------------------------------------------------------------------
// Schema validation helpers
// ---------------------------------------------------------------------------

/**
 * Thrown when a document fails schema validation on insert.
 * Compatible with the `TalaDbValidationError` exported from `taladb`.
 */
export class TalaDbValidationError extends Error {
  constructor(cause, context) {
    const label = context ? ` (${context})` : '';
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`TalaDB schema validation failed${label}: ${msg}`);
    this.name = 'TalaDbValidationError';
    this.cause = cause;
  }
}

/**
 * Wraps a CloudflareCollection to run writes through a schema.parse() call.
 * @template T
 * @param {CloudflareCollection} col
 * @param {{ schema: { parse(data: unknown): T }, validateOnRead?: boolean }} options
 * @returns {CloudflareCollection}
 */
function applyCloudflareSchema(col, options) {
  const { schema, validateOnRead = false } = options;

  function parseWrite(doc, label) {
    try {
      return schema.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, label);
    }
  }

  function parseRead(doc) {
    try {
      return schema.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, 'read');
    }
  }

  return Object.assign(Object.create(Object.getPrototypeOf(col)), col, {
    async insert(doc) {
      parseWrite(doc, 'insert');
      return col.insert(doc);
    },
    async insertMany(docs) {
      docs.forEach((doc, i) => parseWrite(doc, `insertMany[${i}]`));
      return col.insertMany(docs);
    },
    async find(filter) {
      const docs = await col.find(filter);
      return validateOnRead ? docs.map(parseRead) : docs;
    },
    async findOne(filter) {
      const doc = await col.findOne(filter);
      return validateOnRead && doc !== null ? parseRead(doc) : doc;
    },
  });
}

// ---------------------------------------------------------------------------
// openDurableDB — create a TalaDB-compatible database backed by DO storage
// ---------------------------------------------------------------------------

/**
 * Open a TalaDB database inside a Durable Object.
 *
 * Loads the snapshot from `storage.get(SNAPSHOT_KEY)` on first call (or after
 * hibernation). Call `db.flush()` after mutations to persist the snapshot back
 * to Durable Objects storage.
 *
 * @param {DurableObjectStorage} storage  — `this.ctx.storage` from the DO
 * @returns {Promise<CloudflareDB>}
 */
export async function openDurableDB(storage) {
  const WDB = await loadWasm();

  const snapshotBytes = await storage.get(SNAPSHOT_KEY);
  const db = snapshotBytes
    ? WDB.openWithSnapshot(new Uint8Array(snapshotBytes))
    : WDB.openInMemory();

  return new CloudflareDB(db, storage);
}

// ---------------------------------------------------------------------------
// CloudflareDB — wraps WorkerDB with a TalaDB-compatible API
// ---------------------------------------------------------------------------

class CloudflareDB {
  /** @param {import('../../../taladb-web/pkg/taladb_web.js').WorkerDB} workerDb */
  constructor(workerDb, storage) {
    this._db = workerDb;
    this._storage = storage;
  }

  collection(name, options) {
    const col = new CloudflareCollection(this._db, name, this);
    return options?.schema ? applyCloudflareSchema(col, options) : col;
  }

  /**
   * Persist the current in-memory snapshot to Durable Objects storage.
   * Call after every mutation batch, or at the end of a request handler.
   */
  async flush() {
    const bytes = this._db.exportSnapshot();
    await this._storage.put(SNAPSHOT_KEY, bytes.buffer);
  }

  /** Compact the in-memory redb instance (no-op for in-memory backend). */
  async compact() {
    this._db.compact();
  }

  async close() {}
}

// ---------------------------------------------------------------------------
// CloudflareCollection — synchronous Rust calls wrapped as async
// ---------------------------------------------------------------------------

class CloudflareCollection {
  constructor(db, name, parent) {
    this._db = db;
    this._name = name;
    this._parent = parent;
  }

  async insert(doc) {
    const id = this._db.insert(this._name, JSON.stringify(doc));
    return id;
  }

  async insertMany(docs) {
    const json = this._db.insertMany(this._name, JSON.stringify(docs));
    return JSON.parse(json);
  }

  async find(filter) {
    const json = this._db.find(this._name, filter ? JSON.stringify(filter) : 'null');
    return JSON.parse(json);
  }

  async findOne(filter) {
    const json = this._db.findOne(this._name, filter ? JSON.stringify(filter) : 'null');
    return JSON.parse(json);
  }

  async updateOne(filter, update) {
    return this._db.updateOne(this._name, JSON.stringify(filter), JSON.stringify(update));
  }

  async updateMany(filter, update) {
    return this._db.updateMany(this._name, JSON.stringify(filter), JSON.stringify(update));
  }

  async deleteOne(filter) {
    return this._db.deleteOne(this._name, JSON.stringify(filter));
  }

  async deleteMany(filter) {
    return this._db.deleteMany(this._name, JSON.stringify(filter));
  }

  async count(filter) {
    return this._db.count(this._name, filter ? JSON.stringify(filter) : 'null');
  }

  async createIndex(field) {
    this._db.createIndex(this._name, field);
  }

  async dropIndex(field) {
    this._db.dropIndex(this._name, field);
  }

  async createFtsIndex(field) {
    this._db.createFtsIndex(this._name, field);
  }

  async dropFtsIndex(field) {
    this._db.dropFtsIndex(this._name, field);
  }

  async createVectorIndex(field, options) {
    if (options.indexType === 'hnsw') {
      throw new Error('HNSW vector indexes are not available in Cloudflare Workers (requires native threads). Use Node.js or React Native.');
    }
    this._db.createVectorIndex(
      this._name, field, options.dimensions,
      options.metric ?? null, null, null, null,
    );
  }

  async dropVectorIndex(field) {
    this._db.dropVectorIndex(this._name, field);
  }

  async upgradeVectorIndex(_field) {
    throw new Error('HNSW vector indexes are not available in Cloudflare Workers.');
  }

  async listIndexes() {
    return JSON.parse(this._db.listIndexes(this._name));
  }

  async findNearest(field, vector, topK, filter) {
    const json = this._db.findNearest(
      this._name, field,
      JSON.stringify(vector), topK,
      filter ? JSON.stringify(filter) : 'null',
    );
    return JSON.parse(json);
  }

  subscribe(_filter, _callback) {
    throw new Error('subscribe() is not supported in Cloudflare Workers. Use find() inside request handlers instead.');
  }
}

// ---------------------------------------------------------------------------
// TalaDBDurableObject — base class for Durable Objects using TalaDB
// ---------------------------------------------------------------------------

/**
 * Base Durable Object class. Extend this and export it from your Worker.
 *
 * @example
 * ```ts
 * import { TalaDBDurableObject } from '@taladb/cloudflare';
 *
 * export class MyDB extends TalaDBDurableObject {
 *   async fetch(request: Request): Promise<Response> {
 *     const db = await this.getDB();
 *     const users = db.collection('users');
 *
 *     if (request.method === 'POST') {
 *       const body = await request.json();
 *       const id = await users.insert(body);
 *       await db.flush();
 *       return Response.json({ id });
 *     }
 *
 *     const all = await users.find();
 *     return Response.json(all);
 *   }
 * }
 * ```
 */
export class TalaDBDurableObject {
  constructor(ctx, _env) {
    this.ctx = ctx;
    this._db = null;
  }

  /**
   * Get (or lazily open) the TalaDB database for this Durable Object instance.
   * Caches the open database for the lifetime of the isolate.
   *
   * @returns {Promise<CloudflareDB>}
   */
  async getDB() {
    if (!this._db) {
      this._db = await openDurableDB(this.ctx.storage);
    }
    return this._db;
  }

  /**
   * Default fetch handler — override in your subclass.
   * @param {Request} _request
   * @returns {Promise<Response>}
   */
  async fetch(_request) {
    return new Response('TalaDB Durable Object — override fetch() in your subclass', {
      status: 200,
    });
  }
}
