// MongoDB bidirectional sync adapter for TalaDB.
//
// Uses a MongoDB collection as a shared change store: one document per synced
// TalaDB document (`_id = "<collection>::<docId>"`), holding the latest change
// as a JSON string plus its `changed_at` timestamp. Push does a Last-Write-Wins
// conditional upsert (newer timestamp wins); pull returns every change with a
// `changed_at` after the caller's cursor. Any number of TalaDB peers syncing to
// the same store converge through it.
//
// Server-side only: it holds a MongoDB connection, so run it where you can keep
// database credentials — a Node.js backend, not a browser or mobile client.

import type { SerializedChangeset, SyncAdapter } from 'taladb';
import type { Collection } from 'mongodb';

/** One change-store row: latest change for a document, keyed by collection+id. */
interface ChangeRecord {
  _id: string;
  changed_at: number;
  /** The TalaDB `Change`, serialized — opaque to Mongo, so document bodies with
   * `$`/`.` field names never collide with Mongo operators. */
  change: string;
}

/** Shape of a TalaDB change we key on (the rest is opaque in `change`). */
interface RawChange {
  collection: string;
  id: string;
  changed_at: number;
}

export interface MongoSyncAdapterOptions {
  /**
   * The MongoDB collection to use as the change store. Create it from your own
   * `MongoClient` so the app owns the connection lifecycle. Index `changed_at`
   * for pull performance: `await collection.createIndex({ changed_at: 1 })`.
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
export class MongoSyncAdapter implements SyncAdapter {
  private readonly store: Collection<ChangeRecord>;

  constructor(options: MongoSyncAdapterOptions) {
    this.store = options.collection as unknown as Collection<ChangeRecord>;
  }

  /**
   * Convenience: open a MongoDB connection from a URI and return a ready
   * adapter plus a `close()` to release it. Creates the `changed_at` index.
   *
   * ```ts
   * const { adapter, close } = await MongoSyncAdapter.connect({
   *   uri: process.env.MONGO_URI!, db: 'sync',
   * });
   * await db.sync(adapter, { collections: ['notes'] });
   * await close();
   * ```
   */
  static async connect(opts: {
    uri: string;
    db: string;
    collection?: string;
  }): Promise<{ adapter: MongoSyncAdapter; close: () => Promise<void> }> {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(opts.uri);
    await client.connect();
    const store = client.db(opts.db).collection(opts.collection ?? 'taladb_changes');
    await store.createIndex({ changed_at: 1 });
    return {
      adapter: new MongoSyncAdapter({ collection: store }),
      close: () => client.close(),
    };
  }

  async push(changeset: SerializedChangeset): Promise<void> {
    const changes = JSON.parse(changeset) as RawChange[];
    if (changes.length === 0) return;

    // One Last-Write-Wins conditional upsert per change: a pipeline update that
    // replaces the stored row only when the incoming `changed_at` is newer,
    // and inserts when absent (a missing `changed_at` reads as -1). Correct
    // even with 3+ peers pushing the same document out of order.
    const ops = changes.map((chg) => {
      const key = `${chg.collection}::${chg.id}`;
      return {
        updateOne: {
          filter: { _id: key },
          update: [
            {
              $replaceWith: {
                $cond: [
                  { $gt: [chg.changed_at, { $ifNull: ['$changed_at', -1] }] },
                  { _id: key, changed_at: chg.changed_at, change: JSON.stringify(chg) },
                  '$$ROOT',
                ],
              },
            },
          ],
          upsert: true,
        },
      };
    });

    await this.store.bulkWrite(ops as never, { ordered: false });
  }

  async pull(sinceMs: number): Promise<SerializedChangeset> {
    const rows = await this.store
      .find({ changed_at: { $gt: sinceMs } })
      .sort({ changed_at: 1 })
      .toArray();
    if (rows.length === 0) return '[]';
    // Each row's `change` is already a serialized Change; stitch into an array
    // without re-parsing.
    return `[${rows.map((r) => r.change).join(',')}]`;
  }
}
