import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import type { Document, Filter, TalaDB } from 'taladb'
import { useTalaDB } from '../context'
import { replicate, replicationTarget, type ResolvedReplicationConfig } from './engine'

/** A slice to warm on first run — a collection, optionally on a specific endpoint. */
export type PrefetchSlice = { collection: string; endpoint?: string }
/** A prefetch entry: a collection name (shorthand) or a {@link PrefetchSlice}. */
export type PrefetchEntry = string | PrefetchSlice
/** `'once'` warms a slice only if it has never synced; `'always'` on every mount. */
export type PrefetchMode = 'once' | 'always'

/**
 * Replication settings shared by `useQuery` / `useMutation`, supplied once by
 * `<ReplicationProvider>` and overridable per hook.
 *
 * The origin is *your* API — never a database credential. It authorizes the
 * session token from {@link ReplicationConfig.getAuth} and returns only that
 * user's slice, so the auth header doubles as the per-user scope.
 */
export interface ReplicationConfig {
  /** Base sync URL, e.g. `/api/sync`. `/push` and `/pull` are appended. */
  endpoint: string
  /**
   * Per-request header resolver — typically `{ Authorization: 'Bearer …' }`.
   * Async so it can await a token refresh. Resolved at **send time**, once per
   * pass, so an offline write flushed later carries a current token.
   */
  getAuth?: () => Promise<Record<string, string>> | Record<string, string>
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Override the `/push` and `/pull` sub-paths to match an existing API. */
  paths?: { push?: string; pull?: string }
  /**
   * Default background refresh interval (ms) for `useQuery`. A replication
   * *interval*, not a cache TTL — the local data is never evicted, only
   * refreshed. Omit or set `0` to disable polling by default; a hook can still
   * opt in per query. `30_000` matches the guide's own example cadence.
   */
  pollMs?: number
  /**
   * Slices to warm into the local replica in the background on first run, so a
   * later `useQuery` for that collection reads local instead of waiting on the
   * network. Best-effort and non-blocking: deferred to browser idle, run in the
   * sync Worker on web, and silently skipped on failure. Each entry is a
   * collection name or a {@link PrefetchSlice}.
   */
  prefetch?: PrefetchEntry[]
  /** How prefetch decides to warm a slice. Default `'once'`. */
  prefetchMode?: PrefetchMode
  /** Max concurrent prefetch pulls — keeps the active page from starving. Default `2`. */
  prefetchConcurrency?: number
}

const ReplicationContext = createContext<ReplicationConfig | null>(null)

export interface ReplicationProviderProps extends ReplicationConfig {
  children: ReactNode
}

/**
 * Supplies replication defaults (endpoint, auth, poll interval, prefetch) to the
 * `useQuery` / `useMutation` hooks below it. Compose it inside a
 * `<TalaDBProvider>`:
 *
 * ```tsx
 * <TalaDBProvider name="app.db" fallback={<Splash />}>
 *   <ReplicationProvider
 *     endpoint="/api/sync"
 *     getAuth={async () => ({ Authorization: `Bearer ${await session.token()}` })}
 *     pollMs={30_000}
 *     prefetch={['products', 'categories']}
 *   >
 *     <App />
 *   </ReplicationProvider>
 * </TalaDBProvider>
 * ```
 */
export function ReplicationProvider({ children, ...config }: ReplicationProviderProps) {
  // Serialised identity so an inline `getAuth`/`paths`/`prefetch` object on every
  // render doesn't produce a new context value and re-run every consumer's
  // effects. Functions can't serialise; getAuth is resolved fresh per pass, so
  // its identity is moot.
  const key =
    `${config.endpoint}|${config.pollMs ?? ''}|${JSON.stringify(config.paths ?? null)}` +
    `|${JSON.stringify(config.prefetch ?? null)}|${config.prefetchMode ?? ''}|${config.prefetchConcurrency ?? ''}`
  const value = useMemo(
    () => config,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  )
  return (
    <ReplicationContext.Provider value={value}>
      {value.prefetch && value.prefetch.length > 0 ? <PrefetchRunner /> : null}
      {children}
    </ReplicationContext.Provider>
  )
}

/**
 * Merge a base replication config with per-hook overrides, field-by-field so an
 * override left `undefined` falls back to the base value instead of clobbering
 * it. Pure (no hooks) so it can run per-item inside `useQueries` / prefetch.
 * Returns a `null` config when no endpoint is resolvable (valid for `local-only`).
 */
export function resolveReplicationConfig(
  base: ReplicationConfig | null,
  overrides?: Partial<ReplicationConfig>,
): { config: ResolvedReplicationConfig | null; pollMs: number } {
  const endpoint = overrides?.endpoint ?? base?.endpoint
  const pollMs = overrides?.pollMs ?? base?.pollMs ?? 0
  if (!endpoint) return { config: null, pollMs }
  return {
    config: {
      endpoint,
      getAuth: overrides?.getAuth ?? base?.getAuth,
      fetch: overrides?.fetch ?? base?.fetch,
      paths: overrides?.paths ?? base?.paths,
    },
    pollMs,
  }
}

/** The nearest replication base config, or `null` if there's no provider. */
export function useReplicationBase(): ReplicationConfig | null {
  return useContext(ReplicationContext)
}

/**
 * Read the nearest replication config, merged with per-hook overrides.
 * Non-throwing: `config` is `null` when no endpoint is resolvable (valid for
 * `source: 'local-only'`); the caller decides whether that's an error.
 */
export function useReplicationConfig(
  overrides?: Partial<ReplicationConfig>,
): { config: ResolvedReplicationConfig | null; pollMs: number } {
  return resolveReplicationConfig(useContext(ReplicationContext), overrides)
}

// --------------------------------------------------------------------------
// Prefetch — warm the replica in the background on first run.
// --------------------------------------------------------------------------

// Mirrors the cursor collection in taladb's sync.ts: a target with a cursor doc
// has completed at least one pass, i.e. is not a first-run fetch.
const CURSOR_COLLECTION = '__taladb_sync'

function normalizePrefetch(entries?: PrefetchEntry[]): PrefetchSlice[] {
  return (entries ?? []).map((e) => (typeof e === 'string' ? { collection: e } : e))
}

type Scheduler = (fn: () => void) => () => void

// Yield to first paint / interaction before starting background work. Uses
// requestIdleCallback where available (browsers), else a macrotask.
const idleScheduler: Scheduler = (fn) => {
  const g = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof g.requestIdleCallback === 'function') {
    const id = g.requestIdleCallback(fn, { timeout: 2000 })
    return () => g.cancelIdleCallback?.(id)
  }
  const id = setTimeout(fn, 0)
  return () => clearTimeout(id)
}

let schedule: Scheduler = idleScheduler

/** Test seam: replace the idle scheduler so prefetch starts synchronously. */
export function setPrefetchScheduler(fn: Scheduler): void {
  schedule = fn
}

async function hasSynced(db: TalaDB, target: string): Promise<boolean> {
  try {
    const doc = await db.collection(CURSOR_COLLECTION).findOne({ target } as Filter<Document>)
    return doc != null
  } catch {
    return false
  }
}

/**
 * Renders nothing; warms the local replica in the background. Mounted by
 * `<ReplicationProvider>` only when `prefetch` is set. Best-effort and silent —
 * failures never surface (a later `useQuery` will pull on navigation). Deferred
 * to idle and, on web, executed in the sync Worker, so first paint and
 * interaction are not blocked. Pulls coalesce with any concurrent `useQuery`
 * for the same collection via the engine's in-flight dedup.
 */
export function PrefetchRunner(): null {
  const db = useTalaDB()
  const base = useReplicationBase()
  const slices = normalizePrefetch(base?.prefetch)
  const mode: PrefetchMode = base?.prefetchMode ?? 'once'
  const concurrency = Math.max(1, base?.prefetchConcurrency ?? 2)

  const baseRef = useRef<ReplicationConfig | null>(base)
  baseRef.current = base

  const sig = JSON.stringify({ slices, mode, concurrency, endpoint: base?.endpoint ?? null })

  useEffect(() => {
    if (slices.length === 0) return undefined
    let cancelled = false

    const cancelSchedule = schedule(() => {
      void run()
    })

    async function run(): Promise<void> {
      const b = baseRef.current
      const queue = normalizePrefetch(b?.prefetch)
      const worker = async (): Promise<void> => {
        while (!cancelled) {
          const slice = queue.shift()
          if (!slice) return
          const { config } = resolveReplicationConfig(b, { endpoint: slice.endpoint })
          if (!config) continue
          const target = replicationTarget(config.endpoint, slice.collection)
          if (mode === 'once' && (await hasSynced(db, target))) continue
          if (cancelled) return
          try {
            await replicate(db, config, slice.collection, 'pull')
          } catch {
            /* best-effort — silent; useQuery will retry on navigation */
          }
        }
      }
      const lanes = Math.min(concurrency, queue.length)
      await Promise.all(Array.from({ length: lanes }, () => worker()))
    }

    return () => {
      cancelled = true
      cancelSchedule()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, sig])

  return null
}
