import { SyncAdapter, SerializedChangeset } from 'taladb';
import { Collection } from 'mongodb';

interface MongoSyncAdapterOptions {
    /**
     * The MongoDB collection to use as the change store. Create it from your own
     * `MongoClient` so the app owns the connection lifecycle. Index both fields
     * the adapter queries on:
     * `await collection.createIndex({ changed_at: 1 })` (pull) and
     * `await collection.createIndex({ doc_key: 1 })` (push).
     */
    collection: Collection;
}
/**
 * A {@link SyncAdapter} backed by MongoDB. Pair with `db.sync()`:
 *
 * ```ts
 * import { MongoClient } from 'mongodb';
 * import { MongoSyncAdapter } from '@taladb/sync-mongodb';
 *
 * const client = new MongoClient(process.env.MONGO_URI!);
 * await client.connect();
 * const store = client.db('sync').collection('taladb_changes');
 * const adapter = new MongoSyncAdapter({ collection: store });
 *
 * await db.sync(adapter, { collections: ['notes'] });
 * ```
 *
 * Or let the adapter open the connection for you with {@link MongoSyncAdapter.connect}.
 */
declare class MongoSyncAdapter implements SyncAdapter {
    private readonly store;
    constructor(options: MongoSyncAdapterOptions);
    /**
     * Convenience: open a MongoDB connection from a URI and return a ready
     * adapter plus a `close()` to release it. Creates the indexes the adapter
     * queries on.
     *
     * ```ts
     * const { adapter, close } = await MongoSyncAdapter.connect({
     *   uri: process.env.MONGO_URI!, db: 'sync',
     * });
     * await db.sync(adapter, { collections: ['notes'] });
     * await close();
     * ```
     */
    static connect(opts: {
        uri: string;
        db: string;
        collection?: string;
    }): Promise<{
        adapter: MongoSyncAdapter;
        close: () => Promise<void>;
    }>;
    push(changeset: SerializedChangeset): Promise<void>;
    pull(sinceMs: number): Promise<SerializedChangeset>;
}

export { MongoSyncAdapter, type MongoSyncAdapterOptions };
