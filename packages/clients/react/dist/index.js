"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  TalaDBProvider: () => TalaDBProvider,
  useCollection: () => useCollection,
  useFind: () => useFind,
  useFindOne: () => useFindOne,
  useTalaDB: () => useTalaDB
});
module.exports = __toCommonJS(index_exports);

// src/context.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var TalaDBContext = (0, import_react.createContext)(null);
function TalaDBProvider({ db, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TalaDBContext.Provider, { value: db, children });
}
function useTalaDB() {
  const db = (0, import_react.useContext)(TalaDBContext);
  if (db === null) {
    throw new Error("useTalaDB must be used inside <TalaDBProvider db={...}>");
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
  const snapshotRef = (0, import_react3.useRef)({ data: [], loading: true });
  const filterKey = JSON.stringify(filter ?? null);
  const subscribe = (0, import_react3.useCallback)(
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
  const getSnapshot = (0, import_react3.useCallback)(() => snapshotRef.current, []);
  return (0, import_react3.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
}

// src/useFindOne.ts
var import_react4 = require("react");
function useFindOne(collection, filter) {
  const snapshotRef = (0, import_react4.useRef)({ data: null, loading: true });
  const filterKey = JSON.stringify(filter);
  const subscribe = (0, import_react4.useCallback)(
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
  const getSnapshot = (0, import_react4.useCallback)(() => snapshotRef.current, []);
  return (0, import_react4.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TalaDBProvider,
  useCollection,
  useFind,
  useFindOne,
  useTalaDB
});
