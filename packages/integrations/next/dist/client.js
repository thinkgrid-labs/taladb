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

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  SyncProvider: () => SyncProvider
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_react2 = require("@taladb/react");
var import_jsx_runtime = require("react/jsx-runtime");
function SyncProvider({
  endpoint,
  intervalMs = 3e4,
  headers,
  options,
  onSync,
  onError,
  children
}) {
  const db = (0, import_react2.useTalaDB)();
  const latest = (0, import_react.useRef)({ headers, options, onSync, onError });
  latest.current = { headers, options, onSync, onError };
  const activePass = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    let stopped = false;
    let waitingForActive = false;
    const sync = async () => {
      if (stopped) return;
      if (activePass.current) {
        if (waitingForActive) return;
        waitingForActive = true;
        await activePass.current;
        waitingForActive = false;
        if (!stopped) void sync();
        return;
      }
      const pass = Promise.resolve().then(async () => {
        try {
          const { HttpSyncAdapter } = await import("taladb");
          const h = latest.current.headers;
          const adapter = new HttpSyncAdapter({
            endpoint,
            headers: typeof h === "function" ? h() : h
          });
          const result = await db.sync(adapter, latest.current.options ?? {});
          if (!stopped) latest.current.onSync?.(result);
        } catch (e) {
          if (!stopped) latest.current.onError?.(e);
        }
      });
      activePass.current = pass;
      await pass.finally(() => {
        if (activePass.current === pass) activePass.current = null;
      });
    };
    void sync();
    const tick = intervalMs > 0 ? setInterval(sync, intervalMs) : void 0;
    const onOnline = () => void sync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (tick !== void 0) clearInterval(tick);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [db, endpoint, intervalMs]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SyncProvider
});
