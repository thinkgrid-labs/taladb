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
async function runSync(handle, adapter, options) {
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
  const startedAt = Date.now();
  const local = doPush ? await handle.exportChanges(collections, cursor.pushMs) : "[]";
  let pulled = 0;
  let pullMs = cursor.pullMs;
  if (doPull) {
    const remote = await adapter.pull(cursor.pullMs);
    if (remote && remote !== "[]") {
      pulled = await handle.importChanges(remote);
      for (const c of JSON.parse(remote)) {
        if (typeof c.changed_at === "number" && c.changed_at > pullMs) pullMs = c.changed_at;
      }
    }
  }
  let pushed = 0;
  if (doPush && local !== "[]") {
    pushed = JSON.parse(local).length;
    await adapter.push(local);
  }
  await writeCursor(cursorCol, target, {
    pushMs: doPush ? startedAt : cursor.pushMs,
    pullMs
  });
  return { pushed, pulled, cursor: startedAt };
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
function applySchema(col, options) {
  const { schema, validateOnRead = false } = options;
  if (!schema) return col;
  function parseWrite(doc, label) {
    try {
      return schema.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, label);
    }
  }
  function parseRead(doc) {
    try {
      return schema.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, "read");
    }
  }
  return {
    ...col,
    insert: async (doc) => {
      parseWrite(doc, "insert");
      return col.insert(doc);
    },
    insertMany: async (docs) => {
      docs.forEach((doc, i) => parseWrite(doc, `insertMany[${i}]`));
      return col.insertMany(docs);
    },
    find: validateOnRead ? async (filter) => {
      const docs = await col.find(filter);
      return docs.map((d) => parseRead(d));
    } : col.find.bind(col),
    findOne: validateOnRead ? async (filter) => {
      const doc = await col.findOne(filter);
      return doc === null ? null : parseRead(doc);
    } : col.findOne.bind(col)
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
function makePoller(findFn, callback) {
  let active = true;
  let lastJson = "";
  const poll = async () => {
    if (!active) return;
    try {
      const docs = await findFn();
      const json = JSON.stringify(docs);
      if (json !== lastJson) {
        lastJson = json;
        callback(docs);
      }
    } catch {
    }
    if (active) setTimeout(poll, 300);
  };
  poll();
  return () => {
    active = false;
  };
}
async function createBrowserDB(dbName, config) {
  const workerUrl = new URL("@taladb/web/worker/taladb.worker.js", "react-native://unreachable");
  const worker = new Worker(workerUrl, { type: "module", name: "taladb" });
  const proxy = new WorkerProxy(worker);
  worker.onerror = (e) => {
    proxy.abort(new Error(`taladb worker error: ${e.message ?? "unknown"}`));
  };
  const configJson = config !== void 0 ? JSON.stringify(config) : void 0;
  await proxy.send("init", { dbName, configJson });
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
  function wrapCollection(name, opts) {
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
      subscribe: (filter, callback) => {
        let active = true;
        let lastJson = "";
        let timer = null;
        const poll = async () => {
          if (!active) return;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          try {
            const json = await proxy.send("find", {
              collection: name,
              filterJson: filter ? s(filter) : "null"
            });
            if (json !== lastJson) {
              lastJson = json;
              callback(JSON.parse(json));
            }
          } catch {
          }
          if (active) timer = setTimeout(poll, 300);
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
    listCollectionNames: async () => JSON.parse(await proxy.send("listCollections")),
    sync: (adapter, options) => runSync(handle, adapter, options)
  };
  return handle;
}
async function createNodeDB(dbName, config) {
  const native = await import("./node-A4LKRSW5.mjs");
  const TalaDBNode = native.TalaDbNode ?? native.TalaDBNode;
  if (!TalaDBNode) throw new Error("@taladb/node loaded but exports no TalaDbNode class \u2014 rebuild the native module");
  const configJson = config !== void 0 ? JSON.stringify(config) : null;
  const db = TalaDBNode.open(dbName, configJson);
  function wrapCollection(name, opts) {
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
      subscribe: (filter, callback) => makePoller(async () => col.find(filter ?? null), callback)
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }
  const handle = {
    collection: (name, opts) => wrapCollection(name, opts),
    compact: async () => db.compact(),
    // Releases the native file handle/lock (no-op on older .node binaries).
    close: async () => db.close?.(),
    exportChanges: async (collections, sinceMs) => db.exportChanges(sinceMs, collections),
    importChanges: async (changeset) => db.importChanges(changeset),
    listCollectionNames: async () => db.listCollectionNames(),
    sync: (adapter, options) => runSync(handle, adapter, options)
  };
  return handle;
}
async function createNativeDB(_dbName) {
  const maybeNative = globalThis.__TalaDB__;
  if (!maybeNative) {
    throw new Error(
      "@taladb/react-native JSI HostObject not found. Did you call TalaDBModule.initialize() in your app entry point?"
    );
  }
  const native = maybeNative;
  function wrapCollection(name, opts) {
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
      subscribe: (filter, callback) => makePoller(async () => native.find(name, filter ?? {}), callback)
    };
    return opts ? applySchema(wrapped, opts) : wrapped;
  }
  return {
    collection: (name, opts) => wrapCollection(name, opts),
    compact: async () => native.compact(),
    close: async () => native.close(),
    ...unsupportedSync("react-native")
  };
}
async function openDB(dbName = "taladb.db", options) {
  let resolvedConfig;
  if (options?.config !== void 0) {
    validateConfig(options.config);
    resolvedConfig = options.config;
  } else {
    resolvedConfig = await loadConfig(options?.configPath);
  }
  const platform = detectPlatform();
  switch (platform) {
    case "browser":
      return createBrowserDB(dbName, resolvedConfig);
    case "react-native":
      return createNativeDB(dbName);
    case "node":
      return createNodeDB(dbName, resolvedConfig);
  }
}
export {
  HttpSyncAdapter,
  TalaDbValidationError,
  openDB
};
