// src/index.ts
var MongoSyncAdapter = class _MongoSyncAdapter {
  constructor(options) {
    this.store = options.collection;
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
  static async connect(opts) {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(opts.uri);
    await client.connect();
    const store = client.db(opts.db).collection(opts.collection ?? "taladb_changes");
    await store.createIndex({ changed_at: 1 });
    return {
      adapter: new _MongoSyncAdapter({ collection: store }),
      close: () => client.close()
    };
  }
  async push(changeset) {
    const changes = JSON.parse(changeset);
    if (changes.length === 0) return;
    const ops = changes.map((chg) => {
      const key = `${chg.collection}::${chg.id}`;
      return {
        updateOne: {
          filter: { _id: key },
          update: [
            {
              $replaceWith: {
                $cond: [
                  { $gt: [chg.changed_at, { $ifNull: ["$changed_at", -1] }] },
                  { _id: key, changed_at: chg.changed_at, change: JSON.stringify(chg) },
                  "$$ROOT"
                ]
              }
            }
          ],
          upsert: true
        }
      };
    });
    await this.store.bulkWrite(ops, { ordered: false });
  }
  async pull(sinceMs) {
    const rows = await this.store.find({ changed_at: { $gt: sinceMs } }).sort({ changed_at: 1 }).toArray();
    if (rows.length === 0) return "[]";
    return `[${rows.map((r) => r.change).join(",")}]`;
  }
};
export {
  MongoSyncAdapter
};
