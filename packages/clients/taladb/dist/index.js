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
  TalaDbValidationError: () => TalaDbValidationError,
  openDB: () => openDB
});
module.exports = __toCommonJS(index_exports);

// src/config.ts
var ENDPOINT_FIELDS = [
  "endpoint",
  "insert_endpoint",
  "update_endpoint",
  "delete_endpoint"
];
var LOCALHOST_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function isLocalhostUrl(url) {
  try {
    return LOCALHOST_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
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
    if (url?.startsWith("http://") && !isLocalhostUrl(url)) {
      console.warn(
        `[TalaDB] sync endpoint "${url}" uses plaintext HTTP \u2014 use HTTPS in production to prevent changeset interception`
      );
    }
  }
}
async function loadConfig(configPath) {
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    return {};
  }
  const { join, extname } = await import(
    /* @vite-ignore */
    "path"
  );
  const { readFile, access } = await import(
    /* @vite-ignore */
    "fs/promises"
  );
  async function parseFile(filePath) {
    const content = await readFile(filePath, "utf8");
    const ext = extname(filePath).toLowerCase();
    let raw;
    if (ext === ".json") {
      raw = JSON.parse(content);
    } else if (ext === ".yml" || ext === ".yaml") {
      const yaml = await import(
        /* @vite-ignore */
        "js-yaml"
      );
      raw = yaml.load(content);
    } else {
      throw new Error(
        `TalaDB config: unsupported file extension "${ext}" \u2014 use .json, .yml, or .yaml`
      );
    }
    const config = raw !== null && typeof raw === "object" ? raw : {};
    validateConfig(config);
    return config;
  }
  if (configPath) {
    return parseFile(configPath);
  }
  const cwd = process.cwd();
  for (const name of ["taladb.config.yml", "taladb.config.yaml", "taladb.config.json"]) {
    const full = join(cwd, name);
    try {
      await access(full);
      return parseFile(full);
    } catch {
    }
  }
  return {};
}

// src/index.ts
var import_meta = {};
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
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ id, op, ...args });
    });
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
  const workerUrl = new URL("@taladb/web/worker/taladb.worker.js", import_meta.url);
  const worker = new Worker(workerUrl, { type: "module", name: "taladb" });
  const proxy = new WorkerProxy(worker);
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
        let lastJson = "[]";
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
  return {
    collection: (name, opts) => wrapCollection(name, opts),
    compact: () => proxy.send("compact"),
    close: async () => {
      channel?.close();
      await proxy.send("close");
      worker.terminate();
    }
  };
}
async function createNodeDB(dbName, config) {
  const { TalaDBNode } = await import("@taladb/node");
  const configJson = config !== void 0 ? JSON.stringify(config) : null;
  const db = TalaDBNode.open(dbName, configJson);
  function wrapCollection(name, opts) {
    const col = db.collection(name);
    const wrapped = {
      insert: async (doc) => col.insert(doc),
      insertMany: async (docs) => col.insertMany(docs),
      find: async (filter) => col.find(filter ?? null),
      findOne: async (filter) => col.findOne(filter) ?? null,
      updateOne: async (filter, update) => col.updateOne(filter, update),
      updateMany: async (filter, update) => col.updateMany(filter, update),
      deleteOne: async (filter) => col.deleteOne(filter),
      deleteMany: async (filter) => col.deleteMany(filter),
      count: async (filter) => col.count(filter ?? null),
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
  return {
    collection: (name, opts) => wrapCollection(name, opts),
    compact: async () => db.compact(),
    close: async () => {
    }
  };
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
      listIndexes: async () => ({}),
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
    close: async () => native.close()
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TalaDbValidationError,
  openDB
});
