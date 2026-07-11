'use client';

// src/context.tsx
import { createContext, useContext, useEffect, useState } from "react";
import { Fragment, jsx } from "react/jsx-runtime";
var TalaDBContext = createContext(null);
function TalaDBProvider(props) {
  if ("db" in props && props.db) {
    return /* @__PURE__ */ jsx(TalaDBContext.Provider, { value: props.db, children: props.children });
  }
  return /* @__PURE__ */ jsx(NamedProvider, { ...props });
}
function NamedProvider({
  name,
  options,
  fallback = null,
  children
}) {
  const [db, setDb] = useState(null);
  const [error, setError] = useState(null);
  const optionsKey = JSON.stringify(options ?? null);
  useEffect(() => {
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
  if (db === null) return /* @__PURE__ */ jsx(Fragment, { children: fallback });
  return /* @__PURE__ */ jsx(TalaDBContext.Provider, { value: db, children });
}
function useTalaDB() {
  const db = useContext(TalaDBContext);
  if (db === null) {
    throw new Error('useTalaDB must be used inside <TalaDBProvider db={...}> or <TalaDBProvider name="...">');
  }
  return db;
}

// src/useCollection.ts
import { useMemo } from "react";
function useCollection(name) {
  const db = useTalaDB();
  return useMemo(() => db.collection(name), [db, name]);
}

// src/useFind.ts
import { useCallback, useRef, useSyncExternalStore } from "react";
function useFind(collection, filter) {
  const snapshotRef = useRef({ data: [], loading: true, error: null });
  const filterKey = JSON.stringify(filter ?? null);
  const subscribe = useCallback(
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
  const getSnapshot = useCallback(() => snapshotRef.current, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// src/useFindOne.ts
import { useCallback as useCallback2, useRef as useRef2, useSyncExternalStore as useSyncExternalStore2 } from "react";
function useFindOne(collection, filter) {
  const snapshotRef = useRef2({ data: null, loading: true, error: null });
  const filterKey = JSON.stringify(filter);
  const subscribe = useCallback2(
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
  const getSnapshot = useCallback2(() => snapshotRef.current, []);
  return useSyncExternalStore2(subscribe, getSnapshot, getSnapshot);
}

// src/replication/config.tsx
import {
  createContext as createContext2,
  useContext as useContext2,
  useEffect as useEffect2,
  useMemo as useMemo2,
  useRef as useRef3
} from "react";

// src/replication/engine.ts
import { HttpSyncAdapter } from "taladb";
function replicationTarget(endpoint, collection) {
  return `${endpoint}::${collection}`;
}
async function buildAdapter(config) {
  const headers = config.getAuth ? await config.getAuth() : void 0;
  return new HttpSyncAdapter({
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

// src/replication/config.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
var ReplicationContext = createContext2(null);
function ReplicationProvider({ children, ...config }) {
  const key = `${config.endpoint}|${config.pollMs ?? ""}|${JSON.stringify(config.paths ?? null)}|${JSON.stringify(config.prefetch ?? null)}|${config.prefetchMode ?? ""}|${config.prefetchConcurrency ?? ""}`;
  const value = useMemo2(
    () => config,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );
  return /* @__PURE__ */ jsxs(ReplicationContext.Provider, { value, children: [
    value.prefetch && value.prefetch.length > 0 ? /* @__PURE__ */ jsx2(PrefetchRunner, {}) : null,
    children
  ] });
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
  return useContext2(ReplicationContext);
}
function useReplicationConfig(overrides) {
  return resolveReplicationConfig(useContext2(ReplicationContext), overrides);
}
var CURSOR_COLLECTION = "__taladb_sync";
function normalizePrefetch(entries) {
  return (entries ?? []).map((e) => typeof e === "string" ? { collection: e } : e);
}
var idleScheduler = (fn) => {
  const g = globalThis;
  if (typeof g.requestIdleCallback === "function") {
    const id2 = g.requestIdleCallback(fn, { timeout: 2e3 });
    return () => g.cancelIdleCallback?.(id2);
  }
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
};
var schedule = idleScheduler;
async function hasSynced(db, target) {
  try {
    const doc = await db.collection(CURSOR_COLLECTION).findOne({ target });
    return doc != null;
  } catch {
    return false;
  }
}
function PrefetchRunner() {
  const db = useTalaDB();
  const base = useReplicationBase();
  const slices = normalizePrefetch(base?.prefetch);
  const mode = base?.prefetchMode ?? "once";
  const concurrency = Math.max(1, base?.prefetchConcurrency ?? 2);
  const baseRef = useRef3(base);
  baseRef.current = base;
  const sig = JSON.stringify({ slices, mode, concurrency, endpoint: base?.endpoint ?? null });
  useEffect2(() => {
    if (slices.length === 0) return void 0;
    let cancelled = false;
    const cancelSchedule = schedule(() => {
      void run();
    });
    async function run() {
      const b = baseRef.current;
      const queue = normalizePrefetch(b?.prefetch);
      const worker = async () => {
        while (!cancelled) {
          const slice = queue.shift();
          if (!slice) return;
          const { config } = resolveReplicationConfig(b, { endpoint: slice.endpoint });
          if (!config) continue;
          const target = replicationTarget(config.endpoint, slice.collection);
          if (mode === "once" && await hasSynced(db, target)) continue;
          if (cancelled) return;
          try {
            await replicate(db, config, slice.collection, "pull");
          } catch {
          }
        }
      };
      const lanes = Math.min(concurrency, queue.length);
      await Promise.all(Array.from({ length: lanes }, () => worker()));
    }
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [db, sig]);
  return null;
}

// src/useQuery.ts
import { useCallback as useCallback3, useEffect as useEffect3, useRef as useRef4, useState as useState2 } from "react";
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
  const configRef = useRef4(config);
  configRef.current = config;
  const [syncing, setSyncing] = useState2(false);
  const [syncError, setSyncError] = useState2(null);
  const [firstSyncDone, setFirstSyncDone] = useState2(false);
  const endpoint = config?.endpoint;
  const refetch = useCallback3(async () => {
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
  useEffect3(() => {
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
import { useEffect as useEffect4, useRef as useRef5, useState as useState3 } from "react";
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
  const queriesRef = useRef5(queries);
  queriesRef.current = queries;
  const baseRef = useRef5(base);
  baseRef.current = base;
  const [results, setResults] = useState3(
    () => queries.map(() => emptyResult())
  );
  useEffect4(() => {
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
import { useCallback as useCallback4, useEffect as useEffect5, useRef as useRef6, useState as useState4 } from "react";
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
  const configRef = useRef6(config);
  configRef.current = config;
  const [pending, setPending] = useState4(false);
  const [error, setError] = useState4(null);
  const endpoint = config?.endpoint;
  const applyLocal = useCallback4(
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
  const drain = useCallback4(async () => {
    const cfg = configRef.current;
    if (!cfg) return;
    await replicateWithRetry(db, cfg, collection, direction);
  }, [db, collection, direction, endpoint]);
  const mutateAsync = useCallback4(
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
  const mutate = useCallback4(
    (op) => {
      void mutateAsync(op).catch(() => {
      });
    },
    [mutateAsync]
  );
  useEffect5(() => {
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
export {
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
};
