// src/config.browser.ts
var ENDPOINT_FIELDS = [
  "endpoint",
  "insert_endpoint",
  "update_endpoint",
  "delete_endpoint"
];
function validateConfig(config) {
  const sync = config.sync;
  if (!sync) return;
  for (const key of ENDPOINT_FIELDS) {
    const url = sync[key];
    if (url !== void 0 && !url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error(
        `TalaDB config: invalid endpoint URL "${url}" \u2014 must start with http:// or https://`
      );
    }
  }
}
async function loadConfig(_configPath) {
  return {};
}

// src/sync.ts
var CURSOR_COLLECTION = "__taladb_sync";
async function resolveCollections(handle, options) {
  const base = options.collections ?? await handle.listCollectionNames();
  const excluded = new Set(options.exclude ?? []);
  return base.filter((c) => !excluded.has(c) && !c.startsWith("_"));
}
function unsupportedSync(runtime) {
  const err = () => new Error(
    `TalaDB sync is not yet available on the ${runtime} runtime (Node.js is supported today; browser and React Native are in progress). Track it on the roadmap.`
  );
  return {
    sync: () => Promise.reject(err()),
    exportChanges: () => Promise.reject(err()),
    importChanges: () => Promise.reject(err())
  };
}
async function readCursor(cursorCol, target) {
  const doc = await cursorCol.findOne({ target });
  return { pushMs: doc?.pushMs ?? 0, pullMs: doc?.pullMs ?? 0 };
}
async function writeCursor(cursorCol, target, cursor) {
  const updated = await cursorCol.updateOne({ target }, { $set: { ...cursor } });
  if (!updated) {
    await cursorCol.insert({ target, ...cursor });
  }
}
async function runSync(handle, adapter, options, syncSchemas = {}) {
  const direction = options.direction ?? "both";
  const target = options.target ?? "default";
  const doPush = direction === "push" || direction === "both";
  const doPull = direction === "pull" || direction === "both";
  if (doPull && !adapter.pull) {
    throw new Error(`sync direction '${direction}' requires adapter.pull()`);
  }
  if (doPush && !adapter.push) {
    throw new Error(`sync direction '${direction}' requires adapter.push()`);
  }
  const collections = await resolveCollections(handle, options);
  const cursorCol = handle.collection(CURSOR_COLLECTION);
  const cursor = await readCursor(cursorCol, target);
  const local = doPush ? await handle.exportChanges(collections, 0) : "[]";
  const scopedSchemas = {};
  for (const c of collections) {
    if (syncSchemas[c]) scopedSchemas[c] = syncSchemas[c];
  }
  const useValidated = handle.importChangesValidated && Object.keys(scopedSchemas).length > 0;
  let pulled = 0;
  let skipped = 0;
  let quarantined = 0;
  if (doPull) {
    const remote = await adapter.pull(0);
    if (remote && remote !== "[]") {
      if (useValidated) {
        const report = await handle.importChangesValidated(remote, JSON.stringify(scopedSchemas));
        pulled = report.applied;
        skipped = report.skipped;
        quarantined = report.quarantined;
      } else {
        pulled = await handle.importChanges(remote);
      }
    }
  }
  let pushed = 0;
  if (doPush && local !== "[]") {
    pushed = JSON.parse(local).length;
    await adapter.push(local);
  }
  await writeCursor(cursorCol, target, {
    pushMs: cursor.pushMs,
    pullMs: cursor.pullMs
  });
  return { pushed, pulled, skipped, quarantined, cursor: 0 };
}

// src/http-adapter.ts
var HttpSyncAdapter = class {
  constructor(options) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.headers = options.headers ?? {};
    const f = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!f) {
      throw new Error(
        "HttpSyncAdapter: no fetch available. Pass options.fetch on runtimes without a global fetch."
      );
    }
    this.fetchFn = f;
    this.pushPath = options.paths?.push ?? "/push";
    this.pullPath = options.paths?.pull ?? "/pull";
  }
  async push(changeset) {
    const res = await this.fetchFn(`${this.endpoint}${this.pushPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: changeset
    });
    if (!res.ok) {
      throw new Error(`HttpSyncAdapter push failed: ${res.status} ${res.statusText}`);
    }
  }
  async pull(sinceMs) {
    const url = `${this.endpoint}${this.pullPath}?since=${encodeURIComponent(String(sinceMs))}`;
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers });
    if (!res.ok) {
      throw new Error(`HttpSyncAdapter pull failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.text()).trim();
    return body.length === 0 ? "[]" : body;
  }
};

// src/index.ts
var TalaDbValidationError = class extends Error {
  constructor(cause, context) {
    const label = context ? ` (${context})` : "";
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`TalaDB schema validation failed${label}: ${msg}`);
    this.cause = cause;
    this.name = "TalaDbValidationError";
  }
};
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a;
  const bo = b;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k])
  );
}
function applySchema(col, options) {
  const { schema, validateOnRead = false, migrateDocument, syncSchema, persistMigrations = false } = options;
  const targetVersion = syncSchema?.version ?? 0;
  if (migrateDocument && targetVersion < 1) {
    throw new Error("CollectionOptions.migrateDocument requires syncSchema.version (the migration target)");
  }
  if (syncSchema && targetVersion < 1 && (syncSchema.renames || syncSchema.defaults)) {
    throw new Error(
      "CollectionOptions.syncSchema.renames/defaults require syncSchema.version >= 1 \u2014 without a version the import migration step never runs and documents missing the renamed/defaulted fields are quarantined instead of upgraded"
    );
  }
  const stampVersion = targetVersion > 0;
  if (!schema && !migrateDocument && !stampVersion) return col;
  function parseWrite(doc, label) {
    try {
      return schema.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, label);
    }
  }
  function stamp(doc) {
    if (!stampVersion || doc._v !== void 0) return doc;
    return { ...doc, _v: targetVersion };
  }
  function diffUpdate(original, migrated) {
    const $set = {};
    const $unset = {};
    for (const k of Object.keys(migrated)) {
      if (k === "_id") continue;
      if (!deepEqual(migrated[k], original[k])) $set[k] = migrated[k];
    }
    for (const k of Object.keys(original)) {
      if (k !== "_id" && !(k in migrated)) $unset[k] = true;
    }
    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    return Object.keys(update).length ? update : null;
  }
  function migrateRead(doc) {
    if (!migrateDocument) return doc;
    const fromVersion = typeof doc._v === "number" ? doc._v : 0;
    if (fromVersion >= targetVersion) return doc;
    return { ...migrateDocument(doc, fromVersion), _v: targetVersion };
  }
  function validateRead(doc) {
    if (!validateOnRead || !schema) return doc;
    try {
      return schema.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, "read");
    }
  }
  async function persistAll(originals, migrated) {
    if (!persistMigrations) return;
    for (let i = 0; i < originals.length; i++) {
      const original = originals[i];
      if (migrated[i] === original || typeof original._id !== "string") continue;
      const update = diffUpdate(original, migrated[i]);
      if (!update) continue;
      try {
        await col.updateOne({ _id: original._id }, update);
      } catch {
      }
    }
  }
  const wrapReads = Boolean(migrateDocument) || validateOnRead && Boolean(schema);
  const wrapWrites = Boolean(schema) || stampVersion;
  return {
    ...col,
    insert: wrapWrites ? async (doc) => {
      if (schema) parseWrite(doc, "insert");
      return col.insert(stamp(doc));
    } : col.insert.bind(col),
    insertMany: wrapWrites ? async (docs) => {
      if (schema) docs.forEach((doc, i) => parseWrite(doc, `insertMany[${i}]`));
      return col.insertMany(docs.map(stamp));
    } : col.insertMany.bind(col),
    find: wrapReads ? async (filter) => {
      const docs = await col.find(filter);
      const migrated = docs.map(migrateRead);
      await persistAll(docs, migrated);
      return migrated.map(validateRead);
    } : col.find.bind(col),
    findOne: wrapReads ? async (filter) => {
      const doc = await col.findOne(filter);
      if (doc === null) return null;
      const migrated = migrateRead(doc);
      await persistAll([doc], [migrated]);
      return validateRead(migrated);
    } : col.findOne.bind(col),
    // Live queries feed every @taladb/react hook (useFind, useFindOne,
    // useQueries). Leaving them unwrapped meant React components received the
    // un-migrated shape while a direct find() returned the migrated one.
    subscribe: wrapReads ? (filter, callback, onError) => col.subscribe(
      filter,
      (docs) => {
        const migrated = docs.map(migrateRead);
        let out;
        try {
          out = migrated.map(validateRead);
        } catch (err) {
          onError?.(err);
          return;
        }
        callback(out);
        void persistAll(docs, migrated);
      },
      onError
    ) : col.subscribe.bind(col)
  };
}
function detectPlatform() {
  if (typeof navigator !== "undefined" && navigator.product === "ReactNative") {
    return "react-native";
  }
  if (globalThis.nativeCallSyncHook !== void 0) {
    return "react-native";
  }
  if (globalThis.window !== void 0 && typeof navigator !== "undefined") {
    return "browser";
  }
  return "node";
}
var WorkerProxy = class {
  constructor(port) {
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.dead = null;
    this.port = port;
    this.port.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (error === void 0) p.resolve(result);
        else p.reject(new Error(error));
      }
    };
    this.port.start?.();
  }
  send(op, args = {}) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ id, op, ...args });
    });
  }
  /**
   * Reject every in-flight request and refuse new ones. Called when the
   * worker errors or is terminated — without this, pending promises would
   * hang forever (awaiting callers deadlock).
   */
  abort(reason) {
    this.dead = reason;
    for (const [, p] of this.pending) p.reject(reason);
    this.pending.clear();
  }
};
function makePoller(findFn, callback, onError) {
  let active = true;
  let lastJson = "";
  let running = false;
  let rerun = false;
  const poll = async () => {
    if (!active) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const docs = await findFn();
      if (!active) return;
      const json = JSON.stringify(docs);
      if (json !== lastJson) {
        lastJson = json;
        callback(docs);
      }
    } catch (error) {
      if (active) onError?.(error);
    } finally {
      running = false;
      if (active) {
        if (rerun) {
          rerun = false;
          void poll();
        } else setTimeout(poll, 300);
      }
    }
  };
  poll();
  return () => {
    active = false;
  };
}
async function createBrowserDB(dbName, config, passphrase, migrations) {
  const workerUrl = new URL("@taladb/web/worker/taladb.worker.js", import.meta.url);
  const worker = new Worker(workerUrl, { type: "module", name: "taladb" });
  const proxy = new WorkerProxy(worker);
  worker.onerror = (e) => {
    proxy.abort(new Error(`taladb worker error: ${e.message ?? "unknown"}`));
  };
  const configJson = config !== void 0 ? JSON.stringify(config) : void 0;
  try {
    await proxy.send("init", { dbName, configJson, passphrase });
  } catch (e) {
    proxy.abort(e instanceof Error ? e : new Error(String(e)));
    worker.terminate();
    throw e;
  }
  const nudgeCallbacks = /* @__PURE__ */ new Set();
  let channel = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(`taladb:${dbName}`);
    channel.onmessage = (e) => {
      if (e.data === "taladb:changed") {
        for (const nudge of nudgeCallbacks) nudge();
      }
    };
  }
  const syncSchemas = {};
  function wrapCollection(name, opts) {
    if (opts?.syncSchema) syncSchemas[name] = opts.syncSchema;
    const s = JSON.stringify;
    const wrapped = {
      insert: (doc) => proxy.send("insert", { collection: name, docJson: s(doc) }),
      insertMany: async (docs) => {
        const json = await proxy.send("insertMany", {
          collection: name,
          docsJson: s(docs)
        });
        return JSON.parse(json);
      },
      find: async (filter) => {
        const json = await proxy.send("find", {
          collection: name,
          filterJson: filter ? s(filter) : "null"
        });
        return JSON.parse(json);
      },
      findOne: async (filter) => {
        const json = await proxy.send("findOne", {
          collection: name,
          filterJson: filter ? s(filter) : "null"
        });
        return JSON.parse(json);
      },
      updateOne: (filter, update) => proxy.send("updateOne", {
        collection: name,
        filterJson: s(filter),
        updateJson: s(update)
      }),
      updateMany: (filter, update) => proxy.send("updateMany", {
        collection: name,
        filterJson: s(filter),
        updateJson: s(update)
      }),
      deleteOne: (filter) => proxy.send("deleteOne", { collection: name, filterJson: s(filter) }),
      deleteMany: (filter) => proxy.send("deleteMany", { collection: name, filterJson: s(filter) }),
      count: (filter) => proxy.send("count", {
        collection: name,
        filterJson: filter ? s(filter) : "null"
      }),
      aggregate: async (pipeline) => {
        const json = await proxy.send("aggregate", {
          collection: name,
          pipelineJson: s(pipeline)
        });
        return JSON.parse(json);
      },
      createIndex: (field) => proxy.send("createIndex", { collection: name, field }),
      dropIndex: (field) => proxy.send("dropIndex", { collection: name, field }),
      createCompoundIndex: (fields) => proxy.send("createCompoundIndex", { collection: name, fieldsJson: JSON.stringify(fields) }),
      dropCompoundIndex: (fields) => proxy.send("dropCompoundIndex", { collection: name, fieldsJson: JSON.stringify(fields) }),
      createFtsIndex: (field) => proxy.send("createFtsIndex", { collection: name, field }),
      dropFtsIndex: (field) => proxy.send("dropFtsIndex", { collection: name, field }),
      createVectorIndex: (field, options) => {
        if (options.indexType === "hnsw") return Promise.reject(new Error("HNSW vector indexes are not available in the browser (requires native threads). Use Node.js or React Native."));
        return proxy.send("createVectorIndex", {
          collection: name,
          field,
          dimensions: options.dimensions,
          metric: options.metric,
          indexType: null,
          hnswM: null,
          hnswEfConstruction: null
        });
      },
      dropVectorIndex: (field) => proxy.send("dropVectorIndex", { collection: name, field }),
      upgradeVectorIndex: (_field) => Promise.reject(new Error("HNSW vector indexes are not available in the browser (requires native threads). Use Node.js or React Native.")),
      listIndexes: async () => {
        const json = await proxy.send("listIndexes", { collection: name });
        return JSON.parse(json);
      },
      findNearest: async (field, vector, topK, filter) => {
        const json = await proxy.send("findNearest", {
          collection: name,
          field,
          queryJson: JSON.stringify(vector),
          topK,
          filterJson: filter ? JSON.stringify(filter) : "null"
        });
        return JSON.parse(json);
      },
      subscribe: (filter, callback, onError) => {
        let active = true;
        let lastJson = "";
        let timer = null;
        let running = false;
        let rerun = false;
        const poll = async () => {
          if (!active) return;
          if (running) {
            rerun = true;
            return;
          }
          running = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          try {
            const json = await proxy.send("find", {
              collection: name,
              filterJson: filter ? s(filter) : "null"
            });
            if (!active) return;
            if (json !== lastJson) {
              lastJson = json;
              callback(JSON.parse(json));
            }
          } catch (error) {
            if (active) onError?.(error);
          } finally {
            running = false;
          }
          if (active) {
            if (rerun) {
              rerun = false;
              void poll();
            } else timer = setTimeout(poll, 300);
          }
        };
        nudgeCallbacks.add(poll);
        poll();
        return () => {
          active = false;
          nudgeCallbacks.delete(poll);
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        };
      }
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }
  const handle = {
    collection: (name, opts) => wrapCollection(name, opts),
    compact: () => proxy.send("compact"),
    flush: async () => {
      await proxy.send("flush");
    },
    syncStatus: async () => JSON.parse(await proxy.send("syncStatus")),
    flushSync: (timeoutMs = 5e3) => proxy.send("flushSync", { timeoutMs }),
    close: async () => {
      channel?.close();
      try {
        await proxy.send("close");
      } finally {
        worker.terminate();
        proxy.abort(new Error("taladb worker closed"));
      }
    },
    // All engine work (export scan, LWW merge) runs inside the worker, off the
    // main thread — a sync pass never blocks rendering, whatever its size.
    exportChanges: (collections, sinceMs) => proxy.send("exportChangeset", { collectionsJson: JSON.stringify(collections), sinceMs }),
    importChanges: (changeset) => proxy.send("importChangeset", { changesetJson: changeset }),
    importChangesValidated: async (changeset, schemasJson) => JSON.parse(await proxy.send("importChangesetValidated", { changesetJson: changeset, schemasJson })),
    listCollectionNames: async () => JSON.parse(await proxy.send("listCollections")),
    quarantined: async (collection) => JSON.parse(await proxy.send("quarantined", { collection })),
    sync: (adapter, options) => runSync(handle, adapter, options, syncSchemas)
  };
  if (migrations?.length) {
    await runMigrations(
      handle,
      async () => proxy.send("userVersion"),
      async (v) => {
        await proxy.send("setUserVersion", { version: v });
      },
      migrations
    );
  }
  return handle;
}
async function createNodeDB(dbName, config, passphrase, migrations) {
  const native = await import("./node-A4LKRSW5.mjs");
  const TalaDBNode = native.TalaDbNode ?? native.TalaDBNode;
  if (!TalaDBNode) throw new Error("@taladb/node loaded but exports no TalaDbNode class \u2014 rebuild the native module");
  const configJson = config !== void 0 ? JSON.stringify(config) : null;
  const db = TalaDBNode.open(dbName, configJson, passphrase ?? null);
  const syncSchemas = {};
  function wrapCollection(name, opts) {
    if (opts?.syncSchema) syncSchemas[name] = opts.syncSchema;
    const col = db.collection(name);
    const wrapped = {
      insert: async (doc) => col.insertAsync ? col.insertAsync(doc) : col.insert(doc),
      insertMany: async (docs) => col.insertManyAsync ? col.insertManyAsync(docs) : col.insertMany(docs),
      find: async (filter) => col.findAsync ? col.findAsync(filter ?? null) : col.find(filter ?? null),
      findOne: async (filter) => col.findOne(filter) ?? null,
      updateOne: async (filter, update) => col.updateOneAsync ? col.updateOneAsync(filter, update) : col.updateOne(filter, update),
      updateMany: async (filter, update) => col.updateManyAsync ? col.updateManyAsync(filter, update) : col.updateMany(filter, update),
      deleteOne: async (filter) => col.deleteOneAsync ? col.deleteOneAsync(filter) : col.deleteOne(filter),
      deleteMany: async (filter) => col.deleteManyAsync ? col.deleteManyAsync(filter) : col.deleteMany(filter),
      count: async (filter) => col.count(filter ?? null),
      aggregate: async (pipeline) => col.aggregate(pipeline),
      createIndex: async (field) => col.createIndex(field),
      dropIndex: async (field) => col.dropIndex(field),
      createCompoundIndex: async (fields) => col.createCompoundIndex(fields),
      dropCompoundIndex: async (fields) => col.dropCompoundIndex(fields),
      createFtsIndex: async (field) => col.createFtsIndex(field),
      dropFtsIndex: async (field) => col.dropFtsIndex(field),
      createVectorIndex: async (field, options) => col.createVectorIndex(field, options.dimensions, options.metric ?? null, options.indexType ?? null, options.hnswM ?? null, options.hnswEfConstruction ?? null),
      dropVectorIndex: async (field) => col.dropVectorIndex(field),
      upgradeVectorIndex: async (field) => col.upgradeVectorIndex(field),
      listIndexes: async () => {
        const json = col.listIndexes();
        return JSON.parse(json);
      },
      findNearest: async (field, vector, topK, filter) => {
        const raw = await col.findNearest(field, vector, topK, filter ?? null);
        return raw;
      },
      subscribe: (filter, callback, onError) => makePoller(async () => col.find(filter ?? null), callback, onError)
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }
  const handle = {
    collection: (name, opts) => wrapCollection(name, opts),
    compact: async () => db.compact(),
    // Releases the native file handle/lock (no-op on older .node binaries).
    close: async () => db.close?.(),
    flush: db.flush ? async () => {
      db.flush();
    } : void 0,
    exportChanges: async (collections, sinceMs) => db.exportChanges(sinceMs, collections),
    importChanges: async (changeset) => db.importChanges(changeset),
    // Feature-detected: only present when the loaded .node binary supports it,
    // so older prebuilt binaries fall back to plain importChanges.
    importChangesValidated: db.importChangesValidated ? async (changeset, schemasJson) => db.importChangesValidated(changeset, schemasJson) : void 0,
    listCollectionNames: async () => db.listCollectionNames(),
    quarantined: async (collection) => db.quarantined ? db.quarantined(collection) : [],
    sync: (adapter, options) => runSync(handle, adapter, options, syncSchemas)
  };
  if (migrations?.length) {
    if (typeof db.userVersion !== "function" || typeof db.setUserVersion !== "function") {
      throw new Error("openDB({ migrations }) requires @taladb/node \u2265 0.9.2 \u2014 rebuild the native module");
    }
    await runMigrations(
      handle,
      async () => db.userVersion(),
      async (v) => db.setUserVersion(v),
      migrations
    );
  }
  return handle;
}
async function createNativeDB(_dbName, migrations) {
  const maybeNative = globalThis.__TalaDB__;
  if (!maybeNative) {
    throw new Error(
      "@taladb/react-native JSI HostObject not found. Did you call TalaDBModule.initialize() in your app entry point?"
    );
  }
  const native = maybeNative;
  const syncSchemas = {};
  function wrapCollection(name, opts) {
    if (opts?.syncSchema) syncSchemas[name] = opts.syncSchema;
    const wrapped = {
      insert: async (doc) => native.insert(name, doc),
      insertMany: async (docs) => native.insertMany(name, docs),
      find: async (filter) => native.find(name, filter ?? {}),
      findOne: async (filter) => native.findOne(name, filter ?? {}),
      updateOne: async (filter, update) => native.updateOne(name, filter, update),
      updateMany: async (filter, update) => native.updateMany(name, filter, update),
      deleteOne: async (filter) => native.deleteOne(name, filter),
      deleteMany: async (filter) => native.deleteMany(name, filter),
      count: async (filter) => native.count(name, filter ?? {}),
      aggregate: async (pipeline) => native.aggregate(name, pipeline),
      createIndex: async (field) => native.createIndex(name, field),
      dropIndex: async (field) => native.dropIndex(name, field),
      createCompoundIndex: async (fields) => native.createCompoundIndex(name, fields),
      dropCompoundIndex: async (fields) => native.dropCompoundIndex(name, fields),
      createFtsIndex: async (field) => native.createFtsIndex(name, field),
      dropFtsIndex: async (field) => native.dropFtsIndex(name, field),
      createVectorIndex: async (field, options) => {
        const opts2 = {};
        if (options.metric) opts2.metric = options.metric;
        if (options.hnswM || options.hnswEfConstruction) {
          opts2.hnsw = { m: options.hnswM, efConstruction: options.hnswEfConstruction };
        }
        return native.createVectorIndex(name, field, options.dimensions, opts2);
      },
      dropVectorIndex: async (field) => native.dropVectorIndex(name, field),
      upgradeVectorIndex: async (field) => native.upgradeVectorIndex(name, field),
      // The JSI HostObject does not expose index introspection yet; return a
      // correctly-shaped empty result rather than `{}` cast to the interface.
      listIndexes: async () => ({ btree: [], fts: [], vector: [] }),
      findNearest: async (field, vector, topK, filter) => {
        const raw = native.findNearest(name, field, vector, topK, filter ?? null);
        return raw;
      },
      subscribe: (filter, callback, onError) => makePoller(async () => native.find(name, filter ?? {}), callback, onError)
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }
  const syncSurface = typeof native.exportChanges === "function" && typeof native.importChanges === "function" && typeof native.listCollectionNames === "function" ? (() => {
    const handle2 = {
      collection: (name, opts) => wrapCollection(name, opts),
      exportChanges: async (collections, sinceMs) => native.exportChanges(collections, sinceMs),
      importChanges: async (changeset) => native.importChanges(changeset),
      // Feature-detected: present on 0.9.2+ JSI HostObjects; when absent,
      // runSync falls back to unvalidated importChanges.
      importChangesValidated: native.importChangesValidated ? async (changeset, schemasJson) => native.importChangesValidated(changeset, schemasJson) : void 0,
      listCollectionNames: async () => native.listCollectionNames(),
      sync: (adapter, options) => runSync(handle2, adapter, options, syncSchemas)
    };
    return {
      exportChanges: handle2.exportChanges,
      importChanges: handle2.importChanges,
      sync: handle2.sync
    };
  })() : unsupportedSync("react-native");
  const handle = {
    collection: (name, opts) => wrapCollection(name, opts),
    compact: async () => native.compact(),
    close: async () => native.close(),
    flush: native.flush ? async () => {
      native.flush();
    } : void 0,
    quarantined: native.quarantined ? async (collection) => native.quarantined(collection) : void 0,
    ...syncSurface
  };
  if (migrations?.length) {
    if (typeof native.userVersion !== "function" || typeof native.setUserVersion !== "function") {
      throw new Error(
        "openDB({ migrations }) is not available on this @taladb/react-native binary yet (the JSI HostObject does not expose userVersion/setUserVersion). Update the native module."
      );
    }
    await runMigrations(
      handle,
      async () => native.userVersion(),
      async (v) => native.setUserVersion(v),
      migrations
    );
  }
  return handle;
}
async function runMigrations(db, getVersion, setVersion, migrations) {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i].version;
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`TalaDB migration version must be a positive integer, got ${v}`);
    }
    if (i > 0 && v === sorted[i - 1].version) {
      throw new Error(`TalaDB duplicate migration version ${v}`);
    }
  }
  const current = await getVersion();
  for (const m of sorted) {
    if (m.version <= current) continue;
    await m.up(db);
    await setVersion(m.version);
  }
}
async function openDB(dbName = "taladb.db", options) {
  if (options?.passphrase !== void 0 && options.passphrase.length === 0) {
    throw new Error("TalaDB encryption passphrase must not be empty");
  }
  let resolvedConfig;
  if (options?.config !== void 0) {
    validateConfig(options.config);
    resolvedConfig = options.config;
  } else {
    resolvedConfig = await loadConfig(options?.configPath);
  }
  if (options?.durability) {
    resolvedConfig = {
      ...resolvedConfig,
      durability: { ...resolvedConfig?.durability, ...options.durability }
    };
  }
  const platform = detectPlatform();
  const migrations = options?.migrations;
  switch (platform) {
    case "browser":
      return createBrowserDB(dbName, resolvedConfig, options?.passphrase, migrations);
    case "react-native":
      if (options?.passphrase !== void 0) {
        throw new Error("On React Native, pass the passphrase in the config JSON to TalaDBModule.initialize(); refusing to assume the already-open native database is encrypted");
      }
      return createNativeDB(dbName, migrations);
    case "node":
      return createNodeDB(dbName, resolvedConfig, options?.passphrase, migrations);
  }
}
export {
  HttpSyncAdapter,
  TalaDbValidationError,
  applySchema,
  openDB,
  runMigrations
};
