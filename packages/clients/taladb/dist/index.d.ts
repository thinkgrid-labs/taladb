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
    createIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
    dropIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
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
    subscribe(filter: Filter<T>, callback: (docs: T[]) => void): () => void;
}
interface TalaDB {
    collection<T extends Document = Document>(name: string, options?: CollectionOptions<T>): Collection<T>;
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

export { type Collection, type CollectionIndexInfo, type CollectionOptions, type Document, type Filter, type OpenDBOptions, type Schema, type SyncConfig, type TalaDB, type TalaDbConfig, TalaDbValidationError, type Update, type Value, type VectorIndexOptions, type VectorMetric, type VectorSearchResult, openDB };
