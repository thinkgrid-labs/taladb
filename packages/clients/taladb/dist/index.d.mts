/** Similarity metric used for vector search. */
type VectorMetric = 'cosine' | 'dot' | 'euclidean';
interface VectorIndexOptions {
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
interface CollectionIndexInfo {
    /** B-tree indexes (created with `createIndex`). */
    btree: string[];
    /** Full-text search indexes (created with `createFtsIndex`). */
    fts: string[];
    /** Vector indexes (created with `createVectorIndex`). */
    vector: string[];
}
/** A single result returned by `Collection.findNearest`. */
interface VectorSearchResult<T extends Document = Document> {
    /** The matched document. */
    document: T;
    /**
     * Similarity score — higher means more similar.
     * Range depends on metric: cosine ∈ [-1,1], dot ∈ ℝ, euclidean ∈ (0,1].
     */
    score: number;
}
type Value = null | boolean | number | string | Uint8Array | Value[] | {
    [key: string]: Value;
};
type Document = {
    _id?: string;
    [key: string]: Value | undefined;
};
type FieldOps<T> = T extends null | undefined ? {
    $exists?: boolean;
} : {
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
type Filter<T extends Document = Document> = {
    [K in keyof T]?: T[K] | FieldOps<T[K]>;
} & {
    $and?: Filter<T>[];
    $or?: Filter<T>[];
    $not?: Filter<T>;
};
type Update<T extends Document = Document> = {
    $set?: Partial<T>;
    $unset?: {
        [K in keyof T]?: true;
    };
    $inc?: {
        [K in keyof T]?: number;
    };
    $push?: {
        [K in keyof T]?: Value;
    };
    $pull?: {
        [K in keyof T]?: Value;
    };
};
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
interface Schema<T> {
    parse(data: unknown): T;
}
/** Options passed to `db.collection()`. */
interface CollectionOptions<T extends Document = Document> {
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
}
/** A single MongoDB-style aggregation stage. */
type AggregateStage<T extends Document = Document> = {
    $match: Filter<T>;
} | {
    /** `_id` is a `"$field"` reference or `null` (single group); other keys are
     * accumulator outputs, e.g. `total: { $sum: '$amount' }`, `n: { $sum: 1 }`. */
    $group: {
        _id: string | null;
    } & Record<string, unknown>;
} | {
    $sort: Record<string, 1 | -1>;
} | {
    $skip: number;
} | {
    $limit: number;
} | {
    $project: Record<string, 0 | 1>;
};
/** An ordered aggregation pipeline. */
type AggregatePipeline<T extends Document = Document> = AggregateStage<T>[];
interface Collection<T extends Document = Document> {
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
    createVectorIndex(field: keyof Omit<T, '_id'> & string, options: VectorIndexOptions): Promise<void>;
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
    findNearest(field: keyof Omit<T, '_id'> & string, vector: number[], topK: number, filter?: Filter<T>): Promise<VectorSearchResult<T>[]>;
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
    subscribe(filter: Filter<T>, callback: (docs: T[]) => void, onError?: (error: unknown) => void): () => void;
}
/**
 * A JSON-encoded changeset — the opaque payload exchanged between peers. Produced
 * by {@link TalaDB.exportChanges}, transported by a {@link SyncAdapter}, and
 * consumed by {@link TalaDB.importChanges}. Treat it as an opaque string.
 */
type SerializedChangeset = string;
/** Direction of a sync pass. `'both'` (default) is fully bidirectional. */
type SyncDirection = 'push' | 'pull' | 'both';
/**
 * A transport for {@link TalaDB.sync}. Implement `push` to send local changes to
 * a remote, `pull` to fetch remote changes — or both for bidirectional sync.
 * The changeset is an opaque JSON string; move it over any wire you like.
 */
interface SyncAdapter {
    /** Send a local changeset to the remote. Required for `'push'` / `'both'`. */
    push?(changeset: SerializedChangeset): Promise<void>;
    /**
     * Fetch remote changes with `changed_at` after `sinceMs` (ms epoch), as a
     * serialized changeset. Return `'[]'` when there is nothing new. Required for
     * `'pull'` / `'both'`.
     */
    pull?(sinceMs: number): Promise<SerializedChangeset>;
}
interface SyncOptions {
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
interface SyncResult {
    /** Number of local changes pushed to the remote. */
    pushed: number;
    /** Number of documents changed locally by the pulled remote changeset. */
    pulled: number;
    /** Active sync cursor. Currently `0` because timestamp adapters replay safely. */
    cursor: number;
}
interface TalaDB {
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
    /** Browser HTTP-push queue health, when supported by the active binding. */
    syncStatus?(): Promise<{
        pending: number;
        dropped: number;
        failed: number;
    }>;
    /** Wait for accepted browser HTTP-push events, returning false on timeout. */
    flushSync?(timeoutMs?: number): Promise<boolean>;
    close(): Promise<void>;
}

/** HTTP push sync settings. */
interface SyncConfig {
    /**
     * Enable HTTP push sync. Defaults to `false`.
     * Everything is a no-op when disabled, so a config block without
     * `enabled: true` is safe to ship.
     */
    enabled?: boolean;
    /**
     * Default endpoint URL that receives all mutation events.
     * Required when `enabled: true`.
     */
    endpoint?: string;
    /** HTTP headers sent with every outgoing request (e.g. `Authorization`). */
    headers?: Record<string, string>;
    /** Override the endpoint for `insert` events only. */
    insert_endpoint?: string;
    /** Override the endpoint for `update` events only. */
    update_endpoint?: string;
    /** Override the endpoint for `delete` events only. */
    delete_endpoint?: string;
    /**
     * Document fields to omit from every outgoing sync payload.
     *
     * Useful for stripping large computed fields such as embedding vectors
     * that the remote endpoint doesn't need.
     *
     * @example
     * exclude_fields: ['embedding', 'clip_vector']
     */
    exclude_fields?: string[];
}
/** Top-level TalaDB configuration. */
interface TalaDbConfig {
    /** HTTP push sync configuration. Disabled by default. */
    sync?: SyncConfig;
}

interface HttpSyncAdapterOptions {
    /** Base URL, e.g. `https://api.example.com/sync`. `/push` and `/pull` are appended. */
    endpoint: string;
    /** Extra headers on every request — typically `Authorization`. */
    headers?: Record<string, string>;
    /**
     * `fetch` implementation. Defaults to the global `fetch` (Node 18+, browsers,
     * React Native). Inject a custom one for tests or non-standard environments.
     */
    fetch?: typeof fetch;
    /** Paths appended to `endpoint`. Override to match an existing API. */
    paths?: {
        push?: string;
        pull?: string;
    };
}
/**
 * A ready-to-use {@link SyncAdapter} that syncs over plain HTTP. Pair it with
 * {@link TalaDB.sync}:
 *
 * ```ts
 * const adapter = new HttpSyncAdapter({
 *   endpoint: 'https://api.example.com/sync',
 *   headers: { Authorization: `Bearer ${token}` },
 * });
 * await db.sync(adapter, { collections: ['notes'] });
 * ```
 */
declare class HttpSyncAdapter implements SyncAdapter {
    private readonly endpoint;
    private readonly headers;
    private readonly fetchFn;
    private readonly pushPath;
    private readonly pullPath;
    constructor(options: HttpSyncAdapterOptions);
    push(changeset: SerializedChangeset): Promise<void>;
    pull(sinceMs: number): Promise<SerializedChangeset>;
}

/**
 * Thrown when a document fails schema validation on `insert` or `insertMany`.
 * The `cause` property holds the original error thrown by the schema library.
 */
declare class TalaDbValidationError extends Error {
    readonly cause: unknown;
    constructor(cause: unknown, context?: string);
}

/** Options for `openDB`. */
interface OpenDBOptions {
    /** Encrypt native database values at rest. Never hard-code this value. */
    passphrase?: string;
    /**
     * Explicit path to a `taladb.config.yml` / `taladb.config.json` file.
     * If omitted, TalaDB auto-discovers the file from `process.cwd()` on Node.js.
     * Ignored on browser and React Native — those platforms do not support
     * file-based config discovery. Pass `config` inline instead, or on React Native
     * pass `JSON.stringify(config)` as the second argument to `TalaDBModule.initialize`.
     */
    configPath?: string;
    /**
     * Inline config object. Takes precedence over any config file when provided.
     * Useful for passing config programmatically without a config file on disk.
     */
    config?: TalaDbConfig;
}
/**
 * Open a TalaDB database.
 *
 * @param dbName   Name of the database file (used for OPFS and native file paths).
 * @param options  Optional config. Pass `{ config }` for inline sync settings or
 *                 `{ configPath }` to load from a specific file.
 *
 * @example
 * const db = await openDB('myapp.db');
 *
 * @example with inline sync config
 * const db = await openDB('myapp.db', {
 *   config: { sync: { enabled: true, endpoint: 'https://api.example.com/events' } },
 * });
 */
declare function openDB(dbName?: string, options?: OpenDBOptions): Promise<TalaDB>;

export { type AggregatePipeline, type AggregateStage, type Collection, type CollectionIndexInfo, type CollectionOptions, type Document, type Filter, HttpSyncAdapter, type OpenDBOptions, type Schema, type SerializedChangeset, type SyncAdapter, type SyncConfig, type SyncDirection, type SyncOptions, type SyncResult, type TalaDB, type TalaDbConfig, TalaDbValidationError, type Update, type Value, type VectorIndexOptions, type VectorMetric, type VectorSearchResult, openDB };
