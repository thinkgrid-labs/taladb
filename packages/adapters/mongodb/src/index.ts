// MongoDB bidirectional sync adapter for TalaDB.
//
// Uses a MongoDB collection as a shared change store, holding changes as opaque
// JSON strings plus their `changed_at` timestamp. Push keeps the greatest
// timestamp seen per synced document; pull returns every change with a
// `changed_at` after the caller's cursor. Any number of TalaDB peers syncing to
// the same store converge through it.
//
// The store deliberately does *not* pick a single winner among changes that
// arrive with equal `changed_at`. TalaDB core breaks such ties by comparing the
// serialized document bytes (`sync::doc_tie_break_wins`) — a rule every replica
// evaluates identically, which is what makes them converge without a
// coordinator. A store that kept only the first equal-timestamp arrival would
// destroy the candidate that rule needs: peers holding the *other* version
// would correctly reject the one the server kept, and never converge. So we
// retain every distinct candidate at the greatest timestamp and let core decide
// — the same contract `memorySyncStore` and `taladbSyncStore` implement.
//
// Server-side only: it holds a MongoDB connection, so run it where you can keep
// database credentials — a Node.js backend, not a browser or mobile client.

import { createHash } from 'node:crypto';
import type { SerializedChangeset, SyncAdapter } from 'taladb';
import type { Collection } from 'mongodb';

/**
 * One change-store row. A document may hold several rows at once: one per
 * distinct candidate sharing the greatest `changed_at` (see the note above).
 * `_id` is derived from the content, so re-pushing a change already stored is
 * an idempotent no-op rather than a duplicate row.
 */
interface ChangeRecord {
  _id: string;
  /** `"<collection>::<docId>"` — the synced document this change belongs to. */
  doc_key: string;
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
export class MongoSyncAdapter implements SyncAdapter {
  private readonly store: Collection<ChangeRecord>;

  constructor(options: MongoSyncAdapterOptions) {
    this.store = options.collection as unknown as Collection<ChangeRecord>;
  }

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
  static async connect(opts: {
    uri: string;
    db: string;
    collection?: string;
  }): Promise<{ adapter: MongoSyncAdapter; close: () => Promise<void> }> {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(opts.uri);
    await client.connect();
    const store = client.db(opts.db).collection(opts.collection ?? 'taladb_changes');
    await store.createIndex({ changed_at: 1 }); // pull's cursor scan
    await store.createIndex({ doc_key: 1 }); // push's supersede-prune
    return {
      adapter: new MongoSyncAdapter({ collection: store }),
      close: () => client.close(),
    };
  }

  async push(changeset: SerializedChangeset): Promise<void> {
    const changes = JSON.parse(changeset) as RawChange[];
    if (changes.length === 0) return;

    const docKeyOf = (chg: RawChange) => `${chg.collection}::${chg.id}`;

    // The greatest timestamp already stored per document. A change below it is
    // superseded and must not be kept — only the greatest timestamp's cohort
    // survives, and core tie-breaks within that cohort.
    const stored = await this.store
      .find(
        { doc_key: { $in: [...new Set(changes.map(docKeyOf))] } },
        { projection: { doc_key: 1, changed_at: 1 } },
      )
      .toArray();
    const storedMax = new Map<string, number>();
    for (const row of stored) {
      storedMax.set(row.doc_key, Math.max(storedMax.get(row.doc_key) ?? -1, row.changed_at));
    }

    // Fold in what this push carries: the winning timestamp for each document is
    // the greatest of what is stored and what is arriving.
    const winning = new Map(storedMax);
    for (const chg of changes) {
      const key = docKeyOf(chg);
      winning.set(key, Math.max(winning.get(key) ?? -1, chg.changed_at));
    }

    // Keep only changes *at* the winning timestamp. Each row's `_id` hashes its
    // content, so `$setOnInsert` makes a re-push land on itself: pushing the same
    // change twice, or two peers pushing an identical change, leaves one row —
    // while two peers pushing *different* changes at the same timestamp leave
    // both, which is exactly what core's tie-break needs to see.
    const inserts = changes
      .filter((chg) => chg.changed_at === winning.get(docKeyOf(chg)))
      .map((chg) => {
        const change = JSON.stringify(chg);
        const docKey = docKeyOf(chg);
        const digest = createHash('sha256').update(change).digest('hex').slice(0, 16);
        return {
          updateOne: {
            filter: { _id: `${docKey}::${chg.changed_at}::${digest}` },
            update: { $setOnInsert: { doc_key: docKey, changed_at: chg.changed_at, change } },
            upsert: true,
          },
        };
      });

    // Drop rows the winning timestamp supersedes. `$lt` keeps the equal-timestamp
    // cohort intact and never touches a concurrent push at a higher timestamp.
    const prunes = [...winning]
      .filter(([key, ts]) => stored.some((r) => r.doc_key === key && r.changed_at < ts))
      .map(([key, ts]) => ({
        deleteMany: { filter: { doc_key: key, changed_at: { $lt: ts } } },
      }));

    // Insert before pruning, so a document is never momentarily absent from the
    // store — a concurrent pull sees the old row or both, never neither.
    //
    // Reading the stored maximum and then writing is not atomic: a push racing
    // this one can land a higher timestamp in between, leaving the row we just
    // wrote already superseded. That costs a redundant row, not correctness —
    // core applies Last-Write-Wins on import, so a superseded candidate loses to
    // the newer one whichever order it arrives in, and the next push above its
    // timestamp prunes it. Serialize pushes if you want the store itself kept
    // exact.
    if (inserts.length > 0) await this.store.bulkWrite(inserts as never, { ordered: false });
    if (prunes.length > 0) await this.store.bulkWrite(prunes as never, { ordered: false });
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
