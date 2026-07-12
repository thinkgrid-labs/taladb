'use client';

// src/client.tsx
import { useEffect, useRef } from "react";
import { useTalaDB } from "@taladb/react";
import { Fragment, jsx } from "react/jsx-runtime";
function SyncProvider({
  endpoint,
  intervalMs = 3e4,
  headers,
  options,
  onSync,
  onError,
  children
}) {
  const db = useTalaDB();
  const latest = useRef({ headers, options, onSync, onError });
  latest.current = { headers, options, onSync, onError };
  const activePass = useRef(null);
  useEffect(() => {
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
  return /* @__PURE__ */ jsx(Fragment, { children });
}
export {
  SyncProvider
};
