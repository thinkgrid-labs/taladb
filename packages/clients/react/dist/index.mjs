'use client';

// src/context.tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Fragment, jsx } from "react/jsx-runtime";
var TalaDBContext = createContext(null);
var CollectionOptionsContext = createContext({
  get: () => void 0
});
function useCollectionOptions() {
  return useContext(CollectionOptionsContext);
}
function CollectionOptionsProvider({
  collections,
  children
}) {
  const latest = useRef(collections);
  latest.current = collections;
  const resolver = useMemo(
    () => ({
      get: (name) => latest.current?.[name]
    }),
    []
  );
  return /* @__PURE__ */ jsx(CollectionOptionsContext.Provider, { value: resolver, children });
}
function TalaDBProvider(props) {
  if ("db" in props && props.db) {
    return /* @__PURE__ */ jsx(TalaDBContext.Provider, { value: props.db, children: /* @__PURE__ */ jsx(CollectionOptionsProvider, { collections: props.collections, children: props.children }) });
  }
  return /* @__PURE__ */ jsx(NamedProvider, { ...props });
}
function NamedProvider({
  name,
  options,
  fallback = null,
  collections,
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
  return /* @__PURE__ */ jsx(TalaDBContext.Provider, { value: db, children: /* @__PURE__ */ jsx(CollectionOptionsProvider, { collections, children }) });
}
function useTalaDB() {
  const db = useContext(TalaDBContext);
  if (db === null) {
    throw new Error('useTalaDB must be used inside <TalaDBProvider db={...}> or <TalaDBProvider name="...">');
  }
  return db;
}

// src/useCollection.ts
import { useMemo as useMemo2, useRef as useRef2 } from "react";
function useCollection(name, options) {
  const db = useTalaDB();
  const registry = useCollectionOptions();
  const explicit = useRef2(options);
  explicit.current = options;
  return useMemo2(
    () => db.collection(name, explicit.current ?? registry.get(name)),
    [db, name, registry]
  );
}

// src/useFind.ts
import { useCallback, useRef as useRef3, useSyncExternalStore } from "react";
function useFind(collection, filter) {
  const snapshotRef = useRef3({ data: [], loading: true, error: null });
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
import { useCallback as useCallback2, useRef as useRef4, useSyncExternalStore as useSyncExternalStore2 } from "react";
function useFindOne(collection, filter) {
  const snapshotRef = useRef4({ data: null, loading: true, error: null });
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

// src/useAggregate.ts
import { useCallback as useCallback3, useRef as useRef5, useSyncExternalStore as useSyncExternalStore3 } from "react";
function useAggregate(collection, pipeline) {
  const snapshotRef = useRef5({ data: [], loading: true, error: null });
  const pipelineKey = JSON.stringify(pipeline);
  const subscribe = useCallback3(
    (notify) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true, error: null };
      return collection.subscribeAggregate(
        pipeline,
        (docs) => {
          snapshotRef.current = { data: docs, loading: false, error: null };
          notify();
        },
        (error) => {
          snapshotRef.current = { ...snapshotRef.current, loading: false, error };
          notify();
        }
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, pipelineKey]
  );
  const getSnapshot = useCallback3(() => snapshotRef.current, []);
  return useSyncExternalStore3(subscribe, getSnapshot, getSnapshot);
}

// src/replication/config.tsx
import {
  createContext as createContext3,
  useContext as useContext3,
  useEffect as useEffect3,
  useMemo as useMemo4,
  useRef as useRef7
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

// src/replication/provider.tsx
import {
  createContext as createContext2,
  useContext as useContext2,
  useEffect as useEffect2,
  useMemo as useMemo3,
  useRef as useRef6,
  useState as useState2
} from "react";
import {
  ReplicationCoordinator,
  createRestSource
} from "taladb";
import { jsx as jsx2 } from "react/jsx-runtime";
var ReplicationContext = createContext2(null);
function whenIdle(fn) {
  const ric = globalThis.requestIdleCallback;
  if (typeof ric === "function") {
    const handle = ric(fn, { timeout: 2e3 });
    return () => {
      const cic = globalThis.cancelIdleCallback;
      cic?.(handle);
    };
  }
  const t = setTimeout(fn, 0);
  return () => clearTimeout(t);
}
var yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));
function ReplicationScopes({ replicate: replicate2, children }) {
  const db = useTalaDB();
  const collectionOptions = useCollectionOptions();
  const [coverage, setCoverage] = useState2({});
  const registryKey = JSON.stringify(
    Object.fromEntries(
      Object.entries(replicate2).map(([name, s]) => [
        name,
        {
          endpoint: s.endpoint,
          origin: s.origin,
          scope: s.scope,
          projectionVersion: s.projectionVersion,
          schemaVersion: s.schemaVersion,
          key: s.key,
          hydrate: s.hydrate,
          pageSize: s.pageSize,
          refreshMs: s.refreshMs,
          bridge: s.bridge,
          source: s.source ? {
            origin: s.source.origin,
            collection: s.source.collection,
            scope: s.source.scope,
            projectionVersion: s.source.projectionVersion,
            schemaVersion: s.source.schemaVersion,
            configVersion: s.source.configVersion
          } : null
        }
      ])
    )
  );
  const latest = useRef6(replicate2);
  latest.current = replicate2;
  const coordinators = useMemo3(() => {
    const map = /* @__PURE__ */ new Map();
    for (const [collection, scope] of Object.entries(latest.current)) {
      const source = scope.source ?? createRestSource({ ...scope, collection });
      map.set(
        collection,
        new ReplicationCoordinator(db, source, {
          pageSize: scope.pageSize,
          yieldFn: yieldToUi,
          onProgress: (state) => setCoverage((prev) => ({ ...prev, [collection]: state })),
          collectionOptions: collectionOptions.get(collection)
        })
      );
    }
    return map;
  }, [db, registryKey, collectionOptions]);
  useEffect2(() => {
    let cancelled = false;
    void (async () => {
      const seeded = {};
      for (const [collection, coord] of coordinators) {
        seeded[collection] = await coord.getCoverage();
      }
      if (!cancelled) setCoverage(seeded);
    })();
    return () => {
      cancelled = true;
    };
  }, [coordinators]);
  useEffect2(() => {
    const cancels = [];
    for (const [collection, coord] of coordinators) {
      const mode = latest.current[collection]?.hydrate ?? "idle";
      if (mode === "manual") continue;
      const start = () => {
        void coord.hydrate().catch(() => {
        });
      };
      if (mode === "eager") start();
      else cancels.push(whenIdle(start));
    }
    return () => cancels.forEach((c) => c());
  }, [coordinators]);
  useEffect2(() => {
    const timers = [];
    for (const [collection, coord] of coordinators) {
      const ms = latest.current[collection]?.refreshMs ?? 0;
      if (ms > 0) {
        timers.push(setInterval(() => void coord.refresh().catch(() => {
        }), ms));
      }
    }
    return () => timers.forEach(clearInterval);
  }, [coordinators]);
  const value = useMemo3(
    () => ({ coordinators, scopes: latest.current, coverage }),
    [coordinators, coverage]
  );
  return /* @__PURE__ */ jsx2(ReplicationContext.Provider, { value, children });
}
function useReplication() {
  return useContext2(ReplicationContext);
}

// src/replication/config.tsx
import { jsx as jsx3, jsxs } from "react/jsx-runtime";
var ReplicationContext2 = createContext3(null);
function ReplicationProvider({
  children,
  replicate: replicate2,
  ...config
}) {
  const key = `${config.endpoint ?? ""}|${config.pollMs ?? ""}|${JSON.stringify(config.paths ?? null)}|${JSON.stringify(config.prefetch ?? null)}|${config.prefetchMode ?? ""}|${config.prefetchConcurrency ?? ""}`;
  const value = useMemo4(
    () => config.endpoint ? config : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );
  const inner = /* @__PURE__ */ jsxs(ReplicationContext2.Provider, { value, children: [
    value?.prefetch && value.prefetch.length > 0 ? /* @__PURE__ */ jsx3(PrefetchRunner, {}) : null,
    children
  ] });
  return replicate2 ? /* @__PURE__ */ jsx3(ReplicationScopes, { replicate: replicate2, children: inner }) : inner;
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
  return useContext3(ReplicationContext2);
}
function useReplicationConfig(overrides) {
  return resolveReplicationConfig(useContext3(ReplicationContext2), overrides);
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
  const baseRef = useRef7(base);
  baseRef.current = base;
  const sig = JSON.stringify({ slices, mode, concurrency, endpoint: base?.endpoint ?? null });
  useEffect3(() => {
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

// src/useCoverage.ts
import { isAuthoritative, progress as progressOf, rowsApplied } from "taladb";
function useCoverage(collection) {
  const replication = useReplication();
  const state = replication?.coverage[collection] ?? { status: "empty" };
  return {
    status: state.status,
    ready: isAuthoritative(state),
    rows: rowsApplied(state),
    total: "total" in state ? state.total : void 0,
    progress: progressOf(state),
    reason: state.status === "error" ? state.error : state.status === "best-effort" || state.status === "stale" ? state.reason : void 0
  };
}
var useHydrationProgress = useCoverage;

// src/useQuery.ts
import { useCallback as useCallback4, useEffect as useEffect4, useMemo as useMemo5, useRef as useRef8, useState as useState3 } from "react";
function useQuery(options) {
  const { collection, filter, sort, page, limit, skip, enabled = true } = options;
  const col = useCollection(collection);
  const db = useTalaDB();
  const coverage = useCoverage(collection);
  const replication = useReplication();
  const coord = replication?.coordinators.get(collection);
  const legacyNetworked = !coord && options.source !== "local-only";
  const { config: legacyConfig, pollMs } = useReplicationConfig(options);
  const legacyConfigRef = useRef8(legacyConfig);
  legacyConfigRef.current = legacyConfig;
  const [syncing, setSyncing] = useState3(false);
  const [syncError, setSyncError] = useState3(null);
  const [firstSyncDone, setFirstSyncDone] = useState3(false);
  const legacyRefetch = useCallback4(async () => {
    const cfg = legacyConfigRef.current;
    if (!legacyNetworked || !cfg) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await replicate(db, cfg, collection, "pull");
    } catch (error) {
      setSyncError(error);
    } finally {
      setSyncing(false);
      setFirstSyncDone(true);
    }
  }, [db, collection, legacyNetworked, legacyConfig?.endpoint]);
  useEffect4(() => {
    if (!enabled || !legacyNetworked || !legacyConfig) return;
    void legacyRefetch();
    if (pollMs > 0) {
      const timer = setInterval(() => void legacyRefetch(), pollMs);
      return () => clearInterval(timer);
    }
    return void 0;
  }, [enabled, legacyNetworked, legacyConfig?.endpoint, pollMs, legacyRefetch]);
  const offset = page !== void 0 && limit !== void 0 ? (page - 1) * limit : skip ?? 0;
  const filterKey = JSON.stringify(filter ?? null);
  const sortKey = JSON.stringify(sort ?? null);
  const [bridgeIds, setBridgeIds] = useState3([]);
  const [fetchError, setFetchError] = useState3(null);
  const scopeValue = coord?.replicaScope;
  const bridgeIdKey = (bridgeIds ?? []).join("|");
  const pipeline = useMemo5(() => {
    const stages = [];
    const scoped = scopeValue ? { _replica_scope: scopeValue } : void 0;
    const bridgeOnly = !coverage.ready ? { _id: { $in: bridgeIds ?? [] } } : void 0;
    const matches = [scoped, bridgeOnly, filter].filter(Boolean);
    if (matches.length === 1) stages.push({ $match: matches[0] });
    else if (matches.length > 1) stages.push({ $match: { $and: matches } });
    if (sort) stages.push({ $sort: sort });
    if (coverage.ready && offset > 0) stages.push({ $skip: offset });
    if (limit !== void 0) stages.push({ $limit: limit });
    return stages;
  }, [filterKey, sortKey, offset, limit, coverage.ready, scopeValue, bridgeIdKey]);
  const read = useAggregate(col, enabled ? pipeline : [{ $limit: 0 }]);
  const [fetching, setFetching] = useState3(false);
  const bridgeKey = `${collection}|${filterKey}|${sortKey}|${offset}|${limit}`;
  const canBridge = replication?.scopes[collection]?.bridge !== false;
  useEffect4(() => {
    if (!enabled || coverage.ready || !canBridge) return;
    if (!coord) return;
    let cancelled = false;
    setFetching(true);
    setFetchError(null);
    setBridgeIds([]);
    void coord.bridge({
      filter,
      sort,
      page,
      limit
    }).then((result) => setBridgeIds(result.ids ?? [])).catch((error) => {
      if (!cancelled) setFetchError(error);
    }).finally(() => {
      if (!cancelled) setFetching(false);
    });
    return () => {
      cancelled = true;
    };
  }, [bridgeKey, coverage.ready, canBridge, enabled, coord]);
  const refetch = async () => {
    if (coord) await coord.refresh();
    else await legacyRefetch();
  };
  if (enabled && legacyNetworked && !legacyConfig) {
    throw new Error(
      `useQuery({ collection: '${collection}' }) needs either a coverage-first replicate scope or a legacy sync endpoint. Use source: 'local-only' for a purely local query.`
    );
  }
  return {
    data: read.data,
    total: coverage.total,
    loading: options.source === "remote-first" && legacyNetworked ? read.loading || !firstSyncDone : read.loading,
    error: read.error ?? fetchError,
    fetchError,
    coverage,
    fetching,
    syncing,
    syncError,
    refetch
  };
}

// src/useQueries.ts
import { useEffect as useEffect5, useMemo as useMemo6, useRef as useRef9, useState as useState4 } from "react";
function useQueries(queries) {
  const db = useTalaDB();
  const registry = useCollectionOptions();
  const replication = useReplication();
  const [results, setResults] = useState4(() => queries.map(() => ({ data: [], loading: true, error: null })));
  const [bridgeIds, setBridgeIds] = useState4({});
  const [fetchErrors, setFetchErrors] = useState4({});
  const signature = JSON.stringify(
    queries.map((q) => ({
      collection: q.collection,
      filter: q.filter ?? null,
      sort: q.sort ?? null,
      page: q.page ?? null,
      limit: q.limit ?? null,
      skip: q.skip ?? null,
      enabled: q.enabled ?? true
    }))
  );
  const latest = useRef9(queries);
  latest.current = queries;
  const bridgeManifestKey = JSON.stringify(bridgeIds);
  const replicationReadKey = JSON.stringify(
    queries.map((q) => ({
      scope: replication?.coordinators.get(q.collection)?.replicaScope ?? null,
      ready: replication?.coverage[q.collection]?.status === "complete"
    }))
  );
  useEffect5(() => {
    const current = latest.current;
    setResults(current.map(() => ({ data: [], loading: true, error: null })));
    const unsubs = current.map((q, i) => {
      if (q.enabled === false) return () => {
      };
      const col = db.collection(q.collection, registry.get(q.collection));
      const offset = q.page !== void 0 && q.limit !== void 0 ? (q.page - 1) * q.limit : q.skip ?? 0;
      const pipeline = [];
      const coord = replication?.coordinators.get(q.collection);
      const covered = replication?.coverage[q.collection]?.status === "complete";
      const matches = [
        coord ? { _replica_scope: coord.replicaScope } : void 0,
        !covered ? { _id: { $in: bridgeIds[i] ?? [] } } : void 0,
        q.filter
      ].filter(Boolean);
      if (matches.length === 1) pipeline.push({ $match: matches[0] });
      else if (matches.length > 1) pipeline.push({ $match: { $and: matches } });
      if (q.sort) pipeline.push({ $sort: q.sort });
      if (covered && offset > 0) pipeline.push({ $skip: offset });
      if (q.limit !== void 0) pipeline.push({ $limit: q.limit });
      return col.subscribeAggregate(
        pipeline,
        (docs) => setResults((prev) => {
          const next = [...prev];
          next[i] = { data: docs, loading: false, error: null };
          return next;
        }),
        (error) => setResults((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], loading: false, error };
          return next;
        })
      );
    });
    return () => unsubs.forEach((u) => u());
  }, [db, registry, signature, replicationReadKey, bridgeManifestKey]);
  useEffect5(() => {
    for (const [i, q] of latest.current.entries()) {
      if (q.enabled === false) continue;
      const coord = replication?.coordinators.get(q.collection);
      if (!coord || replication?.scopes[q.collection]?.bridge === false) continue;
      void coord.getCoverage().then((state) => {
        if (state.status === "complete") return;
        return coord.bridge({
          filter: q.filter,
          sort: q.sort,
          page: q.page,
          limit: q.limit
        }).then((result) => {
          setBridgeIds((prev) => ({ ...prev, [i]: result.ids }));
          setFetchErrors((prev) => {
            const next = { ...prev };
            delete next[i];
            return next;
          });
        }).catch((error) => setFetchErrors((prev) => ({ ...prev, [i]: error })));
      });
    }
  }, [replication, signature]);
  return useMemo6(
    () => latest.current.map((q, i) => {
      const state = replication?.coverage[q.collection] ?? { status: "empty" };
      const coverage = {
        status: state.status,
        // Only `complete` licenses a local-only read — see `useCoverage`.
        ready: state.status === "complete",
        rows: "rowsApplied" in state ? state.rowsApplied ?? 0 : 0,
        total: "total" in state ? state.total : void 0,
        progress: state.status === "complete" ? 1 : void 0,
        reason: state.status === "error" ? state.error : state.status === "best-effort" || state.status === "stale" ? state.reason : void 0
      };
      return {
        data: results[i]?.data ?? [],
        total: coverage.total,
        loading: results[i]?.loading ?? true,
        error: results[i]?.error ?? fetchErrors[i] ?? null,
        fetchError: fetchErrors[i] ?? null,
        coverage,
        fetching: false,
        syncing: false,
        syncError: null,
        refetch: async () => {
          await replication?.coordinators.get(q.collection)?.refresh();
        }
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, signature, replication]
  );
}

// src/useMutation.ts
import { useCallback as useCallback5, useEffect as useEffect6, useRef as useRef10, useState as useState5 } from "react";
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
  const configRef = useRef10(config);
  configRef.current = config;
  const [pending, setPending] = useState5(false);
  const [error, setError] = useState5(null);
  const endpoint = config?.endpoint;
  const applyLocal = useCallback5(
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
  const drain = useCallback5(async () => {
    const cfg = configRef.current;
    if (!cfg) return;
    await replicateWithRetry(db, cfg, collection, direction);
  }, [db, collection, direction, endpoint]);
  const mutateAsync = useCallback5(
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
  const mutate = useCallback5(
    (op) => {
      void mutateAsync(op).catch(() => {
      });
    },
    [mutateAsync]
  );
  useEffect6(() => {
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
  useAggregate,
  useCollection,
  useCollectionOptions,
  useCoverage,
  useFind,
  useFindOne,
  useHydrationProgress,
  useMutation,
  useQueries,
  useQuery,
  useReplicationConfig,
  useTalaDB
};
