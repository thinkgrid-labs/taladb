// ============================================================
// TalaDB — Shared TypeScript Types
// ============================================================

// --------------- Vector types ---------------

/** Similarity metric used for vector search. */
export type VectorMetric = 'cosine' | 'dot' | 'euclidean';

export interface VectorIndexOptions {
  /** Number of dimensions in each stored vector. Enforced on insert and search. */
  dimensions: number;
  /** Similarity metric. Defaults to `"cosine"`. */
  metric?: VectorMetric;
  /**
   * Index algorithm. Defaults to `"flat"` (exact brute-force).
   * Use `"hnsw"` for approximate nearest-neighbour search — much faster on
   * large collections at the cost of occasional missed results.
   * Requires the `vector-hnsw` feature to be compiled in.
   */
  indexType?: 'flat' | 'hnsw';
  /** HNSW connectivity parameter M (default 16). Higher = better recall, more memory. */
  hnswM?: number;
  /** HNSW build-time quality parameter ef_construction (default 200). */
  hnswEfConstruction?: number;
}

/** Describes the indexes that exist on a collection. */
export interface CollectionIndexInfo {
  /** B-tree indexes (created with `createIndex`). */
  btree: string[];
  /** Full-text search indexes (created with `createFtsIndex`). */
  fts: string[];
  /** Vector indexes (created with `createVectorIndex`). */
  vector: string[];
}

/** A single result returned by `Collection.findNearest`. */
export interface VectorSearchResult<T extends Document = Document> {
  /** The matched document. */
  document: T;
  /**
   * Similarity score — higher means more similar.
   * Range depends on metric: cosine ∈ [-1,1], dot ∈ ℝ, euclidean ∈ (0,1].
   */
  score: number;
}

export type Value =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Value[]
  | { [key: string]: Value };

export type Document = { _id?: string; [key: string]: Value | undefined };

// --------------- Filter DSL ---------------

type FieldOps<T> = T extends null | undefined
  ? { $exists?: boolean }
  : {
      $eq?: T;
      $ne?: T;
      $gt?: T;
      $gte?: T;
      $lt?: T;
      $lte?: T;
      $in?: T[];
      $nin?: T[];
      $exists?: boolean;
      /** Full-text search: matches documents where this string field contains the given token. */
  $contains?: string;
  $regex?: string;
    };

export type Filter<T extends Document = Document> = {
  [K in keyof T]?: T[K] | FieldOps<T[K]>;
} & {
  $and?: Filter<T>[];
  $or?: Filter<T>[];
  $not?: Filter<T>;
};

// --------------- Update DSL ---------------

export type Update<T extends Document = Document> = {
  $set?: Partial<T>;
  $unset?: { [K in keyof T]?: true };
  $inc?: { [K in keyof T]?: number };
  $push?: { [K in keyof T]?: Value };
  $pull?: { [K in keyof T]?: Value };
};

// --------------- Schema validation ---------------

/**
 * A schema validator compatible with Zod, Valibot, and any library that
 * exposes a `parse(data: unknown): T` method.
 *
 * @example with Zod
 * const schema = z.object({ name: z.string(), age: z.number() });
 * const users = db.collection<z.infer<typeof schema>>('users', { schema });
 *
 * @example with Valibot
 * const schema = v.object({ name: v.string(), age: v.number() });
 * const users = db.collection<v.InferOutput<typeof schema>>('users', { schema });
 */
export interface Schema<T> {
  parse(data: unknown): T;
}

/** Primitive field type for a {@link SyncSchema}. `'any'` requires presence
 * without constraining the value's type. */
export type SyncFieldType = 'bool' | 'int' | 'float' | 'str' | 'bytes' | 'array' | 'object' | 'any';

/**
 * A tolerant, structural schema applied to documents **arriving via sync**
 * (`db.sync()` pull). Distinct from {@link Schema} (Zod/Valibot), which is
 * strict and runs on the *local* `insert` path: sync import is the boundary you
 * don't control, so it validates structurally and never hard-rejects.
 *
 * On import, per document:
 * - `_v` **below** `version` → upgraded in place (missing `defaults` filled,
 *   `_v` stamped) — additive-only migration.
 * - `_v` **above** `version` → accepted untouched (the peer is ahead).
 * - a missing/`null` `required` field or a `types` mismatch → **quarantined**
 *   (set aside, recoverable via {@link TalaDB.quarantined}), never dropped and
 *   never aborting the batch.
 *
 * @example
 * const users = db.collection<User>('users', {
 *   schema: User,                     // strict, on insert
 *   syncSchema: {                     // tolerant, on import
 *     version: 1,
 *     required: ['name'],
 *     types: { name: 'str', age: 'int' },
 *     defaults: { age: 0 },
 *   },
 * });
 */
export interface SyncSchema {
  /** Current document shape version. Omit or `0` to disable the migration step. */
  version?: number;
  /** Fields that must be present and non-null, or the document is quarantined. */
  required?: string[];
  /** Expected primitive type per field. Fields absent here accept any type. */
  types?: Record<string, SyncFieldType>;
  /** Values applied to missing fields when upgrading a below-`version` document. */
  defaults?: Record<string, Value>;
  /**
   * Field renames applied when upgrading a below-`version` document, as
   * `{ oldName: newName }`. If the old field is present and the new one absent,
   * the value moves. Applied before {@link defaults}. Structural (runs in the
   * engine at import) — for renames that need computation, use
   * {@link CollectionOptions.migrateDocument}.
   */
  renames?: Record<string, string>;
}

/** Options passed to `db.collection()`. */
export interface CollectionOptions<T extends Document = Document> {
  /**
   * Schema validator. When provided, every document passed to `insert` and
   * `insertMany` is run through `schema.parse()` before being stored. If
   * validation fails, a `TalaDbValidationError` is thrown.
   *
   * Compatible with Zod (`z.object({...})`), Valibot (`v.object({...})`), or
   * any object with a `parse(data: unknown): T` method.
   */
  schema?: Schema<T>;
  /**
   * When `true`, documents returned by `find` and `findOne` are also passed
   * through `schema.parse()`. Useful for catching schema drift on old data.
   * Defaults to `false`.
   */
  validateOnRead?: boolean;
  /**
   * Tolerant structural schema applied to documents arriving via `db.sync()`.
   * See {@link SyncSchema}. Enables validate-on-import ("validate, never cast")
   * in the core sync path, with `_v` migration and quarantine of bad shapes.
   * Wired on browser (OPFS worker) and Node.js; React Native falls back to
   * unvalidated import until its binding carries the plumbing.
   */
  syncSchema?: SyncSchema;
  /**
   * Lazy, read-time document migration — the arbitrary-JS complement to the
   * structural {@link SyncSchema}. When set, every document returned by `find`
   * / `findOne` whose `_v` is **below** `syncSchema.version` is passed through
   * `migrateDocument(doc, fromVersion)` and stamped to the current version
   * before you see it, so application code always reads the current shape even
   * for documents that predate the schema (renames, computed/derived fields,
   * splits/merges). Runs on **every runtime** (it's a pure read transform in
   * the client — no binding support needed).
   *
   * Requires `syncSchema.version` (the migration target). The transform is
   * applied to the returned value only; it is not persisted back to storage —
   * pair with `openDB({ migrations })` or a `syncSchema` rename to rewrite
   * stored documents eagerly. Must be pure and deterministic.
   *
   * @example
   * const users = db.collection<User>('users', {
   *   syncSchema: { version: 2 },
   *   migrateDocument: (doc, from) =>
   *     from < 2 ? { ...doc, fullName: `${doc.first} ${doc.last}` } : doc,
   * });
   */
  migrateDocument?: (doc: T, fromVersion: number) => T;
}

// --------------- Aggregation ---------------

/** A single MongoDB-style aggregation stage. */
export type AggregateStage<T extends Document = Document> =
  | { $match: Filter<T> }
  | {
      /** `_id` is a `"$field"` reference or `null` (single group); other keys are
       * accumulator outputs, e.g. `total: { $sum: '$amount' }`, `n: { $sum: 1 }`. */
      $group: { _id: string | null } & Record<string, unknown>;
    }
  | { $sort: Record<string, 1 | -1> }
  | { $skip: number }
  | { $limit: number }
  | { $project: Record<string, 0 | 1> };

/** An ordered aggregation pipeline. */
export type AggregatePipeline<T extends Document = Document> = AggregateStage<T>[];

// --------------- Collection interface ---------------

export interface Collection<T extends Document = Document> {
  insert(doc: Omit<T, '_id'>): Promise<string>;
  insertMany(docs: Omit<T, '_id'>[]): Promise<string[]>;
  find(filter?: Filter<T>): Promise<T[]>;
  findOne(filter: Filter<T>): Promise<T | null>;
  updateOne(filter: Filter<T>, update: Update<T>): Promise<boolean>;
  updateMany(filter: Filter<T>, update: Update<T>): Promise<number>;
  deleteOne(filter: Filter<T>): Promise<boolean>;
  deleteMany(filter: Filter<T>): Promise<number>;
  count(filter?: Filter<T>): Promise<number>;
  /**
   * Run a MongoDB-style aggregation pipeline (`$match`, `$group`, `$sort`,
   * `$skip`, `$limit`, `$project`) inside the engine. Returns the resulting
   * documents. Currently available on Node.js and the in-memory browser build.
   *
   * @example
   * const byStatus = await orders.aggregate([
   *   { $group: { _id: '$status', total: { $sum: '$amount' }, n: { $sum: 1 } } },
   *   { $sort: { total: -1 } },
   * ]);
   */
  aggregate<R extends Document = Document>(pipeline: AggregatePipeline<T>): Promise<R[]>;
  createIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  dropIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  /**
   * Create a compound (multi-field) index over an ordered list of fields.
   *
   * The query planner uses it to accelerate an `$and` where **every** field of
   * the index is constrained by equality — e.g. an index on
   * `['userId', 'status']` serves `find({ userId, status })` with a single
   * index scan instead of a full-collection scan. Fields are ascending; a
   * partial-prefix or trailing-range match is not used yet (planned).
   *
   * @example
   * await orders.createCompoundIndex(['userId', 'status'])
   */
  createCompoundIndex(fields: (keyof Omit<T, '_id'> & string)[]): Promise<void>;
  /** Drop a compound index by its ordered field list. */
  dropCompoundIndex(fields: (keyof Omit<T, '_id'> & string)[]): Promise<void>;
  /**
   * Create a full-text search index on a string field.
   *
   * Enables fast `{ field: { $contains: 'token' } }` queries using an
   * inverted token index instead of a full collection scan.
   *
   * @example
   * await notes.createFtsIndex('body');
   */
  createFtsIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  /** Drop a full-text search index. */
  dropFtsIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  /**
   * Return the indexes that currently exist on this collection.
   *
   * @example
   * const { btree, fts, vector } = await notes.listIndexes();
   */
  listIndexes(): Promise<CollectionIndexInfo>;
  /**
   * Create a vector index on a numeric-array field.
   *
   * After creation, `findNearest` can search this field and new inserts/updates
   * automatically maintain the index. Existing documents are backfilled.
   *
   * @example
   * await articles.createVectorIndex('embedding', { dimensions: 384 });
   */
  createVectorIndex(
    field: keyof Omit<T, '_id'> & string,
    options: VectorIndexOptions,
  ): Promise<void>;
  /** Drop a vector index. */
  dropVectorIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  /**
   * Upgrade a flat vector index to HNSW in-place.
   *
   * After calling this, `findNearest` uses approximate nearest-neighbour
   * search which is significantly faster on large collections.
   * Requires the `vector-hnsw` feature to be compiled in; no-op otherwise.
   */
  upgradeVectorIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  /**
   * Find the `topK` most similar documents to `vector` using a vector index.
   *
   * Optionally combine with a metadata `filter` to restrict the search space
   * before ranking — e.g. find the 5 most similar english-language articles.
   *
   * Results are ordered by descending similarity score (highest first).
   *
   * @example
   * const results = await articles.findNearest('embedding', queryVec, 5);
   * // results: Array<{ document: Article, score: number }>
   *
   * @example with pre-filter
   * const results = await articles.findNearest('embedding', queryVec, 5, {
   *   locale: 'en',
   * });
   */
  findNearest(
    field: keyof Omit<T, '_id'> & string,
    vector: number[],
    topK: number,
    filter?: Filter<T>,
  ): Promise<VectorSearchResult<T>[]>;
  /**
   * Subscribe to live query results. The callback receives a full snapshot of
   * matching documents immediately and again after every write that could
   * affect the result set.
   *
   * @returns An unsubscribe function. Call it to stop receiving updates.
   *
   * @example
   * const unsub = users.subscribe({ active: true }, (docs) => {
   *   console.log('active users:', docs);
   * });
   * // later…
   * unsub();
   */
  subscribe(
    filter: Filter<T>,
    callback: (docs: T[]) => void,
    onError?: (error: unknown) => void,
  ): () => void;
}

// --------------- Sync ---------------

/**
 * A JSON-encoded changeset — the opaque payload exchanged between peers. Produced
 * by {@link TalaDB.exportChanges}, transported by a {@link SyncAdapter}, and
 * consumed by {@link TalaDB.importChanges}. Treat it as an opaque string.
 */
export type SerializedChangeset = string;

/** Direction of a sync pass. `'both'` (default) is fully bidirectional. */
export type SyncDirection = 'push' | 'pull' | 'both';

/**
 * A transport for {@link TalaDB.sync}. Implement `push` to send local changes to
 * a remote, `pull` to fetch remote changes — or both for bidirectional sync.
 * The changeset is an opaque JSON string; move it over any wire you like.
 */
export interface SyncAdapter {
  /** Send a local changeset to the remote. Required for `'push'` / `'both'`. */
  push?(changeset: SerializedChangeset): Promise<void>;
  /**
   * Fetch remote changes with `changed_at` after `sinceMs` (ms epoch), as a
   * serialized changeset. Return `'[]'` when there is nothing new. Required for
   * `'pull'` / `'both'`.
   */
  pull?(sinceMs: number): Promise<SerializedChangeset>;
}

export interface SyncOptions {
  /**
   * Collections to sync. Omit to sync **all** user collections (reserved
   * `_`-prefixed collections are always skipped). Provide an array to sync only
   * those.
   */
  collections?: string[];
  /**
   * Collections to skip. Applied after `collections` (or after the
   * all-collections default), so `{ exclude: ['logs'] }` means "sync everything
   * except logs".
   */
  exclude?: string[];
  /** Direction of the pass. Default `'both'` (bidirectional). */
  direction?: SyncDirection;
  /**
   * Names this sync target. Reserved cursor state remains isolated per target
   * for forward compatibility with monotonic server cursors. Default
   * `'default'`.
   */
  target?: string;
}

export interface SyncResult {
  /** Number of local changes pushed to the remote. */
  pushed: number;
  /** Number of documents changed locally by the pulled remote changeset. */
  pulled: number;
  /**
   * Documents in the pulled changeset skipped by an import validator (a
   * collection this client does not model). Present (possibly `0`) whenever a
   * `syncSchema` applied; omitted otherwise.
   */
  skipped?: number;
  /**
   * Documents in the pulled changeset set aside by an import validator because
   * they failed structural validation. Recoverable via {@link TalaDB.quarantined}.
   * Present (possibly `0`) whenever a `syncSchema` applied; omitted otherwise.
   */
  quarantined?: number;
  /** Active sync cursor. Currently `0` because timestamp adapters replay safely. */
  cursor: number;
}

/** A document set aside during a validated sync import, with its rejection reason. */
export interface QuarantinedDocument<T extends Document = Document> {
  /** The rejected document, retained verbatim. */
  document: T;
  /** Human-readable reason the document was quarantined. */
  reason: string;
  /** The `changed_at` (ms epoch) the rejected change carried. */
  changedAt: number;
}

// --------------- TalaDB interface ---------------

export interface TalaDB {
  collection<T extends Document = Document>(name: string, options?: CollectionOptions<T>): Collection<T>;
  /**
   * Run one bidirectional sync pass against `adapter`: pull remote changes and
   * merge them (Last-Write-Wins), then push local changes since the last cursor.
   * The cursor is persisted per `target`, so successive calls sync incrementally.
   * Set `direction` to `'push'` or `'pull'` to make it one-way.
   *
   * @example
   * await db.sync(httpAdapter, { collections: ['notes'] });          // bidirectional
   * await db.sync(httpAdapter, { collections: ['logs'], direction: 'push' });
   */
  sync(adapter: SyncAdapter, options: SyncOptions): Promise<SyncResult>;
  /**
   * Low-level: export changes to `collections` with `changed_at` after `sinceMs`
   * (exclusive) as a serialized changeset. Most apps use {@link TalaDB.sync}.
   */
  exportChanges(collections: string[], sinceMs: number): Promise<SerializedChangeset>;
  /**
   * Low-level: merge a serialized changeset into the local database via
   * Last-Write-Wins. Returns the number of documents changed. Idempotent —
   * re-importing the same changeset is a no-op.
   */
  importChanges(changeset: SerializedChangeset): Promise<number>;
  /**
   * Compact the underlying storage file, reclaiming space freed by deletes
   * and updates.
   *
   * Call during idle periods — e.g. once on startup after `compactTombstones`.
   * No-op on in-memory (IndexedDB-fallback) databases.
   *
   * @example
   * await db.compact();
   */
  compact(): Promise<void>;
  /**
   * Return the documents set aside in `collection`'s quarantine table by a
   * validated sync import (see {@link SyncSchema}). Empty when nothing was
   * quarantined. Wired on browser and Node.js; resolves to `[]` on runtimes
   * without support.
   */
  quarantined?<T extends Document = Document>(collection: string): Promise<QuarantinedDocument<T>[]>;
  /** Browser HTTP-push queue health, when supported by the active binding. */
  syncStatus?(): Promise<{ pending: number; dropped: number; failed: number }>;
  /** Wait for accepted browser HTTP-push events, returning false on timeout. */
  flushSync?(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}
