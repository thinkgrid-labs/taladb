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
var import_node_crypto = require("crypto");
var MongoSyncAdapter = class _MongoSyncAdapter {
  constructor(options) {
    this.store = options.collection;
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
  static async connect(opts) {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(opts.uri);
    await client.connect();
    const store = client.db(opts.db).collection(opts.collection ?? "taladb_changes");
    await store.createIndex({ changed_at: 1 });
    await store.createIndex({ doc_key: 1 });
    return {
      adapter: new _MongoSyncAdapter({ collection: store }),
      close: () => client.close()
    };
  }
  async push(changeset) {
    const changes = JSON.parse(changeset);
    if (changes.length === 0) return;
    const docKeyOf = (chg) => `${chg.collection}::${chg.id}`;
    const stored = await this.store.find(
      { doc_key: { $in: [...new Set(changes.map(docKeyOf))] } },
      { projection: { doc_key: 1, changed_at: 1 } }
    ).toArray();
    const storedMax = /* @__PURE__ */ new Map();
    for (const row of stored) {
      storedMax.set(row.doc_key, Math.max(storedMax.get(row.doc_key) ?? -1, row.changed_at));
    }
    const winning = new Map(storedMax);
    for (const chg of changes) {
      const key = docKeyOf(chg);
      winning.set(key, Math.max(winning.get(key) ?? -1, chg.changed_at));
    }
    const inserts = changes.filter((chg) => chg.changed_at === winning.get(docKeyOf(chg))).map((chg) => {
      const change = JSON.stringify(chg);
      const docKey = docKeyOf(chg);
      const digest = (0, import_node_crypto.createHash)("sha256").update(change).digest("hex").slice(0, 16);
      return {
        updateOne: {
          filter: { _id: `${docKey}::${chg.changed_at}::${digest}` },
          update: { $setOnInsert: { doc_key: docKey, changed_at: chg.changed_at, change } },
          upsert: true
        }
      };
    });
    const prunes = [...winning].filter(([key, ts]) => stored.some((r) => r.doc_key === key && r.changed_at < ts)).map(([key, ts]) => ({
      deleteMany: { filter: { doc_key: key, changed_at: { $lt: ts } } }
    }));
    if (inserts.length > 0) await this.store.bulkWrite(inserts, { ordered: false });
    if (prunes.length > 0) await this.store.bulkWrite(prunes, { ordered: false });
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
