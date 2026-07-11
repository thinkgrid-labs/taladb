/**
 * TalaDB React Native — public JS API.
 *
 * Usage:
 * ```ts
 * import { TalaDBModule, openDB } from '@taladb/react-native';
 *
 * // In App.tsx / index.js (once, at startup)
 * await TalaDBModule.initialize('myapp.db');
 *
 * // Anywhere in the app — same API as browser
 * const db = openDB('myapp.db');
 * const users = db.collection<User>('users');
 * const id = users.insert({ name: 'Alice', age: 30 });
 * ```
 *
 * All operations are **synchronous** via JSI — no async/await needed
 * after initialization.
 */
import NativeTalaDB from './NativeTalaDB';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

export const TalaDBModule = {
  /**
   * Open (or create) the database. Call once at app startup.
   *
   * @param configJson  Optional JSON-serialised `TalaDbConfig` for HTTP push
   *                    sync. Example: `JSON.stringify({ sync: { enabled: true,
   *                    endpoint: 'https://api.example.com/events' } })`.
   */
  initialize: (dbName: string, configJson?: string) =>
    NativeTalaDB.initialize(dbName, configJson),
  /** Close the database gracefully. */
  close: () => NativeTalaDB.close(),
  /** HTTP push events dropped by backpressure or failed after retries. */
  syncStatus: () => native().syncStatus(),
  /** Wait for HTTP push work accepted before this call. */
  flushSync: (timeoutMs = 5000) => native().flushSync(timeoutMs),
};

// ---------------------------------------------------------------------------
// Collection handle
// ---------------------------------------------------------------------------

export interface Document {
  _id?: string;
  [key: string]: unknown;
}

export type Filter = Record<string, unknown>;
export type Update = Record<string, unknown>;

export interface Collection<T extends Document = Document> {
  insert(doc: Omit<T, '_id'>): string;
  insertMany(docs: Omit<T, '_id'>[]): string[];
  find(filter?: Filter): T[];
  findOne(filter: Filter): T | null;
  updateOne(filter: Filter, update: Update): boolean;
  updateMany(filter: Filter, update: Update): number;
  deleteOne(filter: Filter): boolean;
  deleteMany(filter: Filter): number;
  count(filter?: Filter): number;
  createIndex(field: string): void;
  dropIndex(field: string): void;
  createFtsIndex(field: string): void;
  dropFtsIndex(field: string): void;
}

export interface DB {
  collection<T extends Document = Document>(name: string): Collection<T>;
  syncStatus(): { dropped: number; failed: number };
  flushSync(timeoutMs?: number): boolean;
  close(): Promise<void>;
}

interface JsiTalaDB {
  insert(collection: string, doc: Object): string;
  insertMany(collection: string, docs: Object[]): string[];
  find(collection: string, filter: Object | null): Object[];
  findOne(collection: string, filter: Object | null): Object | null;
  updateOne(collection: string, filter: Object, update: Object): boolean;
  updateMany(collection: string, filter: Object, update: Object): number;
  deleteOne(collection: string, filter: Object): boolean;
  deleteMany(collection: string, filter: Object): number;
  count(collection: string, filter: Object | null): number;
  createIndex(collection: string, field: string): void;
  dropIndex(collection: string, field: string): void;
  createFtsIndex(collection: string, field: string): void;
  dropFtsIndex(collection: string, field: string): void;
  syncStatus(): { dropped: number; failed: number };
  flushSync(timeoutMs?: number): boolean;
}

function native(): JsiTalaDB {
  const host = (globalThis as { __TalaDB__?: JsiTalaDB }).__TalaDB__;
  if (!host) throw new Error('TalaDB is not initialized; await TalaDBModule.initialize() first');
  return host;
}

// ---------------------------------------------------------------------------
// openDB — synchronous DB handle (after initialize() has been called)
// ---------------------------------------------------------------------------

/**
 * Get a synchronous DB handle for the given database name.
 *
 * `TalaDBModule.initialize(dbName)` **must** have been awaited before calling
 * this function.
 */
function collection<T extends Document>(colName: string): Collection<T> {
  return {
    insert: (doc) => native().insert(colName, doc as Object),
    insertMany: (docs) => native().insertMany(colName, docs as Object[]),
    find: (filter?) => native().find(colName, filter ?? null) as T[],
    findOne: (filter) => native().findOne(colName, filter) as T | null,
    updateOne: (filter, update) => native().updateOne(colName, filter, update),
    updateMany: (filter, update) => native().updateMany(colName, filter, update),
    deleteOne: (filter) => native().deleteOne(colName, filter),
    deleteMany: (filter) => native().deleteMany(colName, filter),
    count: (filter?) => native().count(colName, filter ?? null),
    createIndex: (field) => native().createIndex(colName, field),
    dropIndex: (field) => native().dropIndex(colName, field),
    createFtsIndex: (field) => native().createFtsIndex(colName, field),
    dropFtsIndex: (field) => native().dropFtsIndex(colName, field),
  };
}

export function openDB(_dbName: string): DB {
  return {
    collection,
    syncStatus: () => native().syncStatus(),
    flushSync: (timeoutMs = 5000) => native().flushSync(timeoutMs),
    close: () => NativeTalaDB.close(),
  };
}
