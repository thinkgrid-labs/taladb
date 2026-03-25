/**
 * TalaDB React Native — public JS API.
 *
 * Usage:
 * ```ts
 * import { TalaDBModule, openDB } from 'taladb-react-native';
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
  /** Open (or create) the database. Call once at app startup. */
  initialize: (dbName: string) => NativeTalaDB.initialize(dbName),
  /** Close the database gracefully. */
  close: () => NativeTalaDB.close(),
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
  close(): Promise<void>;
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
export function openDB(dbName: string): DB {
  function collection<T extends Document>(colName: string): Collection<T> {
    return {
      insert: (doc) => NativeTalaDB.insert(colName, doc as Object),
      insertMany: (docs) => NativeTalaDB.insertMany(colName, docs as Object[]),
      find: (filter?) => NativeTalaDB.find(colName, filter ?? null) as T[],
      findOne: (filter) => NativeTalaDB.findOne(colName, filter) as T | null,
      updateOne: (filter, update) => NativeTalaDB.updateOne(colName, filter, update),
      updateMany: (filter, update) => NativeTalaDB.updateMany(colName, filter, update),
      deleteOne: (filter) => NativeTalaDB.deleteOne(colName, filter),
      deleteMany: (filter) => NativeTalaDB.deleteMany(colName, filter),
      count: (filter?) => NativeTalaDB.count(colName, filter ?? null),
      createIndex: (field) => NativeTalaDB.createIndex(colName, field),
      dropIndex: (field) => NativeTalaDB.dropIndex(colName, field),
      createFtsIndex: (field) => NativeTalaDB.createFtsIndex(colName, field),
      dropFtsIndex: (field) => NativeTalaDB.dropFtsIndex(colName, field),
    };
  }

  return {
    collection,
    close: () => NativeTalaDB.close(),
  };
}
