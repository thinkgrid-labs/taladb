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
  useEffect(() => {
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
  }, [name]);
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
  const snapshotRef = useRef({ data: [], loading: true });
  const filterKey = JSON.stringify(filter ?? null);
  const subscribe = useCallback(
    (notify) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true };
      return collection.subscribe(filter ?? {}, (docs) => {
        snapshotRef.current = { data: docs, loading: false };
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
  const snapshotRef = useRef2({ data: null, loading: true });
  const filterKey = JSON.stringify(filter);
  const subscribe = useCallback2(
    (notify) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true };
      return collection.subscribe(filter, (docs) => {
        snapshotRef.current = { data: docs[0] ?? null, loading: false };
        notify();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, filterKey]
  );
  const getSnapshot = useCallback2(() => snapshotRef.current, []);
  return useSyncExternalStore2(subscribe, getSnapshot, getSnapshot);
}
export {
  TalaDBProvider,
  useCollection,
  useFind,
  useFindOne,
  useTalaDB
};
