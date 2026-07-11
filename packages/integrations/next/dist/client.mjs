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
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const sync = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
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
      } finally {
        inFlight = false;
      }
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
