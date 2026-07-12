import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';
import { SyncOptions, SyncResult } from 'taladb';

interface SyncProviderProps {
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
declare function SyncProvider({ endpoint, intervalMs, headers, options, onSync, onError, children, }: SyncProviderProps): react_jsx_runtime.JSX.Element;

export { SyncProvider, type SyncProviderProps };
