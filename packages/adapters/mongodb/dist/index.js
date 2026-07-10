"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  MongoSyncAdapter: () => MongoSyncAdapter
});
module.exports = __toCommonJS(index_exports);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MongoSyncAdapter
});
