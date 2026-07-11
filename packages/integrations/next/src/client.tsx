// @taladb/next/client — background sync loop for the browser, packaged as a
// provider. Composes with @taladb/react: place it inside <TalaDBProvider> and
// it drives db.sync() on the cadence real local-first apps need — start,
// interval, reconnect, tab focus — entirely off the main thread (the sync
// database scans/merges run inside TalaDB's worker; fetch orchestration remains
// asynchronous on the browser event loop.

import { useEffect, useRef, type ReactNode } from 'react';
import { useTalaDB } from '@taladb/react';
import type { SyncOptions, SyncResult } from 'taladb';

export interface SyncProviderProps {
  /** Base URL of your sync backend, e.g. `/api/sync` (same-origin route
   * handler created with `createSyncHandlers`) or a full URL. */
  endpoint: string;
  /** Milliseconds between passes while the tab is open. Default 30 000. Set
   * `0` to disable the interval (event-driven passes still run). */
  intervalMs?: number;
  /** Headers for every request — typically `Authorization`. Pass a function
   * to read a fresh token per pass. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Scope/direction options forwarded to every `db.sync()` pass. */
  options?: SyncOptions;
  /** Called after each successful pass. */
  onSync?: (result: SyncResult) => void;
  /** Called when a pass fails (offline, 401, server down). The next replayed
   * pass covers the gap. */
  onError?: (error: unknown) => void;
  children?: ReactNode;
}

/**
 * ```tsx
 * // app/providers.tsx
 * 'use client'
 * import { TalaDBProvider } from '@taladb/react'
 * import { SyncProvider } from '@taladb/next/client'
 *
 * export function Providers({ children }) {
 *   return (
 *     <TalaDBProvider name="myapp.db">
 *       <SyncProvider endpoint="/api/sync" headers={() => ({ Authorization: `Bearer ${getToken()}` })}>
 *         {children}
 *       </SyncProvider>
 *     </TalaDBProvider>
 *   )
 * }
 * ```
 */
export function SyncProvider({
  endpoint,
  intervalMs = 30_000,
  headers,
  options,
  onSync,
  onError,
  children,
}: SyncProviderProps) {
  const db = useTalaDB();

  // Latest callbacks/config without re-arming the effect on every render.
  const latest = useRef({ headers, options, onSync, onError });
  latest.current = { headers, options, onSync, onError };
  // Shared across effect generations so changing endpoint/interval/db cannot
  // start a new pass while the previous generation is still finishing.
  const activePass = useRef<Promise<void> | null>(null);

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
          const { HttpSyncAdapter } = await import('taladb');
          const h = latest.current.headers;
          const adapter = new HttpSyncAdapter({
            endpoint,
            headers: typeof h === 'function' ? h() : h,
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

    void sync(); // on mount
    const tick = intervalMs > 0 ? setInterval(sync, intervalMs) : undefined;
    const onOnline = () => void sync();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      if (tick !== undefined) clearInterval(tick);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [db, endpoint, intervalMs]);

  return <>{children}</>;
}
