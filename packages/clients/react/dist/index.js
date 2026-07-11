'use client';
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
  ReplicationProvider: () => ReplicationProvider,
  TalaDBProvider: () => TalaDBProvider,
  useCollection: () => useCollection,
  useFind: () => useFind,
  useFindOne: () => useFindOne,
  useMutation: () => useMutation,
  useQueries: () => useQueries,
  useQuery: () => useQuery,
  useReplicationConfig: () => useReplicationConfig,
  useTalaDB: () => useTalaDB
});
module.exports = __toCommonJS(index_exports);

// src/context.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var TalaDBContext = (0, import_react.createContext)(null);
function TalaDBProvider(props) {
  if ("db" in props && props.db) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TalaDBContext.Provider, { value: props.db, children: props.children });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NamedProvider, { ...props });
}
function NamedProvider({
  name,
  options,
  fallback = null,
  children
}) {
  const [db, setDb] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(null);
  const optionsKey = JSON.stringify(options ?? null);
  (0, import_react.useEffect)(() => {
    setError(null);
    let cancelled = false;
    let opened = null;
    import("taladb").then(({ openDB }) => openDB(name, options)).then((instance) => {
      if (cancelled) {
        void instance.close();
        return;
      }
      opened = instance;
      setDb(instance);
    }).catch((e) => {
      if (!cancelled) setError(e);
    });
    return () => {
      cancelled = true;
      if (opened) void opened.close();
      setDb(null);
    };
  }, [name, optionsKey]);
  if (error !== null) throw error;
  if (db === null) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children: fallback });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TalaDBContext.Provider, { value: db, children });
}
function useTalaDB() {
  const db = (0, import_react.useContext)(TalaDBContext);
  if (db === null) {
    throw new Error('useTalaDB must be used inside <TalaDBProvider db={...}> or <TalaDBProvider name="...">');
  }
  return db;
}

// src/useCollection.ts
var import_react2 = require("react");
function useCollection(name) {
  const db = useTalaDB();
  return (0, import_react2.useMemo)(() => db.collection(name), [db, name]);
}

// src/useFind.ts
var import_react3 = require("react");
function useFind(collection, filter) {
  const snapshotRef = (0, import_react3.useRef)({ data: [], loading: true, error: null });
  const filterKey = JSON.stringify(filter ?? null);
  const subscribe = (0, import_react3.useCallback)(
    (notify) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true, error: null };
      return collection.subscribe(filter ?? {}, (docs) => {
        snapshotRef.current = { data: docs, loading: false, error: null };
        notify();
      }, (error) => {
        snapshotRef.current = { ...snapshotRef.current, loading: false, error };
        notify();
      });
    },
    // filterKey captures the serialised filter; collection is the identity dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, filterKey]
  );
  const getSnapshot = (0, import_react3.useCallback)(() => snapshotRef.current, []);
  return (0, import_react3.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
}

// src/useFindOne.ts
var import_react4 = require("react");
function useFindOne(collection, filter) {
  const snapshotRef = (0, import_react4.useRef)({ data: null, loading: true, error: null });
  const filterKey = JSON.stringify(filter);
  const subscribe = (0, import_react4.useCallback)(
    (notify) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true, error: null };
      return collection.subscribe(filter, (docs) => {
        snapshotRef.current = { data: docs[0] ?? null, loading: false, error: null };
        notify();
      }, (error) => {
        snapshotRef.current = { ...snapshotRef.current, loading: false, error };
        notify();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, filterKey]
  );
  const getSnapshot = (0, import_react4.useCallback)(() => snapshotRef.current, []);
  return (0, import_react4.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
}

// src/replication/config.tsx
var import_react5 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var ReplicationContext = (0, import_react5.createContext)(null);
function ReplicationProvider({ children, ...config }) {
  const key = `${config.endpoint}|${config.pollMs ?? ""}|${JSON.stringify(config.paths ?? null)}`;
  const value = (0, import_react5.useMemo)(
    () => config,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ReplicationContext.Provider, { value, children });
}
function resolveReplicationConfig(base, overrides) {
  const endpoint = overrides?.endpoint ?? base?.endpoint;
  const pollMs = overrides?.pollMs ?? base?.pollMs ?? 0;
  if (!endpoint) return { config: null, pollMs };
  return {
    config: {
      endpoint,
      getAuth: overrides?.getAuth ?? base?.getAuth,
      fetch: overrides?.fetch ?? base?.fetch,
      paths: overrides?.paths ?? base?.paths
    },
    pollMs
  };
}
function useReplicationBase() {
  return (0, import_react5.useContext)(ReplicationContext);
}
function useReplicationConfig(overrides) {
  return resolveReplicationConfig((0, import_react5.useContext)(ReplicationContext), overrides);
}

// src/useQuery.ts
var import_react6 = require("react");

// src/replication/engine.ts
var import_taladb = require("taladb");
function replicationTarget(endpoint, collection) {
  return `${endpoint}::${collection}`;
}
async function buildAdapter(config) {
  const headers = config.getAuth ? await config.getAuth() : void 0;
  return new import_taladb.HttpSyncAdapter({
    endpoint: config.endpoint,
    headers,
    fetch: config.fetch,
    paths: config.paths
  });
}
var inflight = /* @__PURE__ */ new Map();
function inflightKey(endpoint, collection, direction) {
  return `${endpoint}::${collection}::${direction}`;
}
function replicate(db, config, collection, direction) {
  const key = inflightKey(config.endpoint, collection, direction);
  const existing = inflight.get(key);
  if (existing) return existing;
  const pass = (async () => {
    const adapter = await buildAdapter(config);
    await db.sync(adapter, {
      collections: [collection],
      direction,
      target: replicationTarget(config.endpoint, collection)
    });
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pass);
  return pass;
}
var BACKOFFS_MS = [200, 400, 800];
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function replicateWithRetry(db, config, collection, direction) {
  let lastError;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      await replicate(db, config, collection, direction);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < BACKOFFS_MS.length) await sleep(BACKOFFS_MS[attempt]);
    }
  }
  throw lastError;
}

// src/useQuery.ts
function useQuery(options) {
  const { collection, filter, source = "local-first" } = options;
  const networked = source !== "local-only";
  const db = useTalaDB();
  const col = useCollection(collection);
  const read = useFind(col, filter);
  const { config, pollMs } = useReplicationConfig({
    endpoint: options.endpoint,
    getAuth: options.getAuth,
    fetch: options.fetch,
    paths: options.paths,
    pollMs: options.pollMs
  });
  const configRef = (0, import_react6.useRef)(config);
  configRef.current = config;
  const [syncing, setSyncing] = (0, import_react6.useState)(false);
  const [syncError, setSyncError] = (0, import_react6.useState)(null);
  const [firstSyncDone, setFirstSyncDone] = (0, import_react6.useState)(false);
  const endpoint = config?.endpoint;
  const refetch = (0, import_react6.useCallback)(async () => {
    const cfg = configRef.current;
    if (!networked || !cfg) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await replicate(db, cfg, collection, "pull");
    } catch (e) {
      setSyncError(e);
    } finally {
      setSyncing(false);
      setFirstSyncDone(true);
    }
  }, [db, collection, networked, endpoint]);
  (0, import_react6.useEffect)(() => {
    if (!networked) return;
    void refetch();
    if (pollMs > 0) {
      const id = setInterval(() => void refetch(), pollMs);
      return () => clearInterval(id);
    }
    return void 0;
  }, [refetch, networked, pollMs]);
  if (networked && !config) {
    throw new Error(
      `useQuery({ collection: '${collection}' }) needs an endpoint for source '${source}'. Wrap the tree in <ReplicationProvider endpoint="\u2026">, pass { endpoint }, or use source: "local-only".`
    );
  }
  const loading = source === "remote-first" ? read.loading || !firstSyncDone : read.loading;
  return { data: read.data, loading, error: read.error, syncing, syncError, refetch };
}

// src/useQueries.ts
var import_react7 = require("react");
var NOOP_REFETCH = async () => {
};
function emptyResult() {
  return { data: [], loading: true, error: null, syncing: false, syncError: null, refetch: NOOP_REFETCH };
}
function useQueries(queries) {
  const db = useTalaDB();
  const base = useReplicationBase();
  for (const q of queries) {
    const networked = (q.source ?? "local-first") !== "local-only";
    if (networked && !(q.endpoint ?? base?.endpoint)) {
      throw new Error(
        `useQueries: the query for '${q.collection}' needs an endpoint for source '${q.source ?? "local-first"}'. Provide <ReplicationProvider endpoint="\u2026">, pass { endpoint }, or use source: "local-only".`
      );
    }
  }
  const sig = JSON.stringify(
    queries.map((q) => ({
      collection: q.collection,
      filter: q.filter ?? null,
      source: q.source ?? "local-first",
      endpoint: q.endpoint ?? null,
      pollMs: q.pollMs ?? null
    }))
  );
  const queriesRef = (0, import_react7.useRef)(queries);
  queriesRef.current = queries;
  const baseRef = (0, import_react7.useRef)(base);
  baseRef.current = base;
  const [results, setResults] = (0, import_react7.useState)(
    () => queries.map(() => emptyResult())
  );
  (0, import_react7.useEffect)(() => {
    const qs = queriesRef.current;
    const b = baseRef.current;
    let cancelled = false;
    const setAt = (i, fn) => {
      setResults((prev) => {
        if (i >= prev.length) return prev;
        const copy = prev.slice();
        copy[i] = fn(copy[i]);
        return copy;
      });
    };
    const resolved = qs.map((q, i) => {
      const { config } = resolveReplicationConfig(b, {
        endpoint: q.endpoint,
        getAuth: q.getAuth,
        fetch: q.fetch,
        paths: q.paths,
        pollMs: q.pollMs
      });
      const networked = (q.source ?? "local-first") !== "local-only";
      const pollMs = q.pollMs ?? b?.pollMs ?? 0;
      const refetch = async () => {
        if (!networked || !config) return;
        setAt(i, (r) => ({ ...r, syncing: true, syncError: null }));
        try {
          await replicate(db, config, q.collection, "pull");
        } catch (e) {
          if (!cancelled) setAt(i, (r) => ({ ...r, syncError: e }));
        } finally {
          if (!cancelled) setAt(i, (r) => ({ ...r, syncing: false }));
        }
      };
      return { config, networked, pollMs, refetch };
    });
    setResults(
      qs.map((_q, i) => ({
        data: [],
        loading: true,
        error: null,
        syncing: false,
        syncError: null,
        refetch: resolved[i].refetch
      }))
    );
    const unsubs = qs.map((q, i) => {
      const col = db.collection(q.collection);
      return col.subscribe(
        q.filter ?? {},
        (docs) => {
          if (!cancelled) setAt(i, (r) => ({ ...r, data: docs, loading: false, error: null }));
        },
        (error) => {
          if (!cancelled) setAt(i, (r) => ({ ...r, loading: false, error }));
        }
      );
    });
    const intervals = [];
    resolved.forEach((res) => {
      if (!res.networked || !res.config) return;
      void res.refetch();
      if (res.pollMs > 0) intervals.push(setInterval(() => void res.refetch(), res.pollMs));
    });
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      intervals.forEach((id) => clearInterval(id));
    };
  }, [db, sig]);
  return queries.map((_q, i) => results[i] ?? emptyResult());
}

// src/useMutation.ts
var import_react8 = require("react");
function useMutation(options) {
  const { collection, direction = "push", drainOnMount = true } = options;
  const db = useTalaDB();
  const col = useCollection(collection);
  const { config } = useReplicationConfig({
    endpoint: options.endpoint,
    getAuth: options.getAuth,
    fetch: options.fetch,
    paths: options.paths
  });
  const configRef = (0, import_react8.useRef)(config);
  configRef.current = config;
  const [pending, setPending] = (0, import_react8.useState)(false);
  const [error, setError] = (0, import_react8.useState)(null);
  const endpoint = config?.endpoint;
  const applyLocal = (0, import_react8.useCallback)(
    async (op) => {
      switch (op.type) {
        case "insert":
          await col.insert(op.doc);
          return;
        case "update":
          await col.updateOne(op.where, { $set: op.set });
          return;
        case "delete":
          await col.deleteOne(op.where);
          return;
      }
    },
    [col]
  );
  const drain = (0, import_react8.useCallback)(async () => {
    const cfg = configRef.current;
    if (!cfg) return;
    await replicateWithRetry(db, cfg, collection, direction);
  }, [db, collection, direction, endpoint]);
  const mutateAsync = (0, import_react8.useCallback)(
    async (op) => {
      setPending(true);
      setError(null);
      try {
        await applyLocal(op);
        await drain();
      } catch (e) {
        setError(e);
        throw e;
      } finally {
        setPending(false);
      }
    },
    [applyLocal, drain]
  );
  const mutate = (0, import_react8.useCallback)(
    (op) => {
      void mutateAsync(op).catch(() => {
      });
    },
    [mutateAsync]
  );
  (0, import_react8.useEffect)(() => {
    if (!drainOnMount || !configRef.current) return;
    void drain().catch(() => {
    });
  }, [drain, drainOnMount]);
  if (!config) {
    throw new Error(
      `useMutation({ collection: '${collection}' }) needs an endpoint. Wrap the tree in <ReplicationProvider endpoint="\u2026"> or pass { endpoint }.`
    );
  }
  return { mutate, mutateAsync, pending, error };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ReplicationProvider,
  TalaDBProvider,
  useCollection,
  useFind,
  useFindOne,
  useMutation,
  useQueries,
  useQuery,
  useReplicationConfig,
  useTalaDB
});
