import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ReplicationCoordinator,
  createRestSource,
  type CoverageState,
  type Document,
  type ReplicationSource,
  type RestSourceOptions,
} from 'taladb'
import { useCollectionOptions, useTalaDB } from '../context'

/** When the background hydration walk is allowed to start. */
export type HydrateMode =
  /** Immediately on mount. */
  | 'eager'
  /** When the browser is idle (default). Keeps first paint responsive. */
  | 'idle'
  /** Never automatically — the app calls `hydrate()` itself. */
  | 'manual'

export interface ReplicateScope<RemoteRow = any, T extends Document = Document>
  extends Omit<RestSourceOptions<RemoteRow, T>, 'collection'> {
  /**
   * Provide a fully custom source instead of the REST defaults. When present,
   * every other field here is ignored.
   */
  source?: ReplicationSource<RemoteRow, T>
  hydrate?: HydrateMode
  /** Rows per bootstrap page. Default 500. */
  pageSize?: number
  /** Re-check the origin for changes on this interval. `0` disables. */
  refreshMs?: number
  /**
   * Fetch the current query directly when coverage isn't ready yet, so a cold
   * start paints immediately. Default `true`.
   *
   * Mandatory in practice for a Vite SPA or React Native, which have no server
   * render to paint behind while the replica fills.
   */
  bridge?: boolean
}

/** One entry per local collection. */
export type ReplicateRegistry = Record<string, ReplicateScope<any, any>>

interface ReplicationContextValue {
  coordinators: Map<string, ReplicationCoordinator<any, any>>
  scopes: ReplicateRegistry
  /** Live coverage per collection, so hooks re-render as hydration progresses. */
  coverage: Record<string, CoverageState>
}

const ReplicationContext = createContext<ReplicationContextValue | null>(null)

export interface ReplicationScopesProps {
  replicate: ReplicateRegistry
  children: ReactNode
}

/** Defer to browser idle time, falling back to a macrotask. */
function whenIdle(fn: () => void): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: unknown) => number })
    .requestIdleCallback
  if (typeof ric === 'function') {
    const handle = ric(fn, { timeout: 2000 })
    return () => {
      const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback
      cic?.(handle)
    }
  }
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
}

/**
 * Yield between hydration pages.
 *
 * Not cosmetic. Live queries re-run on a 300 ms poll, and on React Native every
 * write is *synchronous on the JS thread* — a tight bootstrap loop starves both,
 * and the app freezes for the length of the import. The whole point of hydrating
 * in the background is that the user doesn't notice, which requires actually
 * giving the thread back.
 */
const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Declares which collections are replicated from which origins, and keeps them
 * hydrated. Mounted for you by `<ReplicationProvider replicate={…}>`.
 *
 * @example
 * <ReplicationProvider replicate={{
 *   products: {
 *     endpoint: '/api/products',
 *     scope: `store:${storeId}`,      // never share coverage across tenants
 *     mapRow: (r) => ({ sku: r.id, name: r.name, price: r.price }),
 *     hydrate: 'idle',
 *     refreshMs: 60_000,
 *   },
 * }}>
 */
export function ReplicationScopes({ replicate, children }: ReplicationScopesProps) {
  const db = useTalaDB()
  const collectionOptions = useCollectionOptions()
  const [coverage, setCoverage] = useState<Record<string, CoverageState>>({})

  // Rebuild only when the *shape* of the config changes — not on every render, or
  // an inline `replicate={{…}}` object would tear down and restart every walk.
  // Functions (mapRow, getAuth) are excluded from the key by JSON.stringify, which
  // is what we want: they are read through the live ref below.
  const registryKey = JSON.stringify(
    Object.fromEntries(
      Object.entries(replicate).map(([name, s]) => [
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
          source: s.source
            ? {
                origin: s.source.origin,
                collection: s.source.collection,
                scope: s.source.scope,
                projectionVersion: s.source.projectionVersion,
                schemaVersion: s.source.schemaVersion,
                configVersion: s.source.configVersion,
              }
            : null,
        },
      ]),
    ),
  )

  const latest = useRef(replicate)
  latest.current = replicate

  const coordinators = useMemo(() => {
    const map = new Map<string, ReplicationCoordinator<any, any>>()
    for (const [collection, scope] of Object.entries(latest.current)) {
      const source =
        scope.source ??
        createRestSource({ ...(scope as RestSourceOptions<any, any>), collection })
      map.set(
        collection,
        new ReplicationCoordinator(db, source, {
          pageSize: scope.pageSize,
          yieldFn: yieldToUi,
          onProgress: (state) => setCoverage((prev) => ({ ...prev, [collection]: state })),
          collectionOptions: collectionOptions.get(collection),
        }),
      )
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, registryKey, collectionOptions])

  // Seed coverage from what's already on disk, so a returning user with a
  // complete replica reads locally on the very first render instead of flashing
  // a bridge fetch.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const seeded: Record<string, CoverageState> = {}
      for (const [collection, coord] of coordinators) {
        seeded[collection] = await coord.getCoverage()
      }
      if (!cancelled) setCoverage(seeded)
    })()
    return () => {
      cancelled = true
    }
  }, [coordinators])

  // Drive the background walk.
  useEffect(() => {
    const cancels: Array<() => void> = []
    for (const [collection, coord] of coordinators) {
      const mode = latest.current[collection]?.hydrate ?? 'idle'
      if (mode === 'manual') continue
      const start = () => {
        // A failed walk leaves an `error` coverage state with a resume point; it
        // is retried on the next mount or explicit hydrate() rather than looping.
        void coord.hydrate().catch(() => {})
      }
      if (mode === 'eager') start()
      else cancels.push(whenIdle(start))
    }
    return () => cancels.forEach((c) => c())
  }, [coordinators])

  // Periodic delta refresh, once a scope is covered.
  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = []
    for (const [collection, coord] of coordinators) {
      const ms = latest.current[collection]?.refreshMs ?? 0
      if (ms > 0) {
        timers.push(setInterval(() => void coord.refresh().catch(() => {}), ms))
      }
    }
    return () => timers.forEach(clearInterval)
  }, [coordinators])

  const value = useMemo<ReplicationContextValue>(
    () => ({ coordinators, scopes: latest.current, coverage }),
    [coordinators, coverage],
  )

  return <ReplicationContext.Provider value={value}>{children}</ReplicationContext.Provider>
}

/** Internal: the replication context, or null when there is no provider. */
export function useReplication(): ReplicationContextValue | null {
  return useContext(ReplicationContext)
}
