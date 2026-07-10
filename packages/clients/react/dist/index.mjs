// src/context.tsx
import { createContext, useContext } from "react";
import { jsx } from "react/jsx-runtime";
var TalaDBContext = createContext(null);
function TalaDBProvider({ db, children }) {
  return /* @__PURE__ */ jsx(TalaDBContext.Provider, { value: db, children });
}
function useTalaDB() {
  const db = useContext(TalaDBContext);
  if (db === null) {
    throw new Error("useTalaDB must be used inside <TalaDBProvider db={...}>");
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
