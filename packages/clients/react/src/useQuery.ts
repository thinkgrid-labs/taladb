import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AggregatePipeline, Document, Filter } from 'taladb'
import { useAggregate } from './useAggregate'
import { useCollection } from './useCollection'
import { useCoverage, type Coverage } from './useCoverage'
import { useReplication } from './replication/provider'
import { useTalaDB } from './context'
import { useReplicationConfig, type ReplicationConfig } from './replication/config'
import { replicate, type ResolvedReplicationConfig } from './replication/engine'

export type ReadSource = 'local-first' | 'remote-first' | 'local-only'

export interface UseQueryOptions<T extends Document>
  extends Partial<Pick<ReplicationConfig, 'endpoint' | 'getAuth' | 'fetch' | 'paths' | 'pollMs'>> {
  /** The local collection to read. */
  collection: string
  /** Mongo-style filter, applied **locally**. */
  filter?: Filter<T>
  /** Sort, applied locally. `1` ascending, `-1` descending. */
  sort?: Partial<Record<keyof T & string, 1 | -1>>
  /** 1-based page number. Requires `limit`. */
  page?: number
  /** Rows per page. */
  limit?: number
  /** Skip N rows. Ignored when `page` is set. */
  skip?: number
  /** Skip the query entirely (e.g. while a route param is undefined). */
  enabled?: boolean
  /** Legacy sync-contract read policy. Used when no full-replication scope exists. */
  source?: ReadSource
}

export interface QueryResult<T> {
  /** The current page. Reactive: re-renders as rows land. */
  data: T[]
  /** Total rows in the replicated scope when reported by the origin. */
  total?: number
  /** True until the first local snapshot arrives. */
  loading: boolean
  /** Most recent local read error. */
  error: unknown | null
  /** Most recent cold-start bridge error. */
  fetchError: unknown | null
  /** How much of the collection is local, and whether it is trustworthy. */
  coverage: Coverage
  /**
   * A cold-start bridge fetch is in flight — we are serving the network because
   * the replica isn't complete yet.
   */
  fetching: boolean
  /** Legacy sync-contract pull in progress. */
  syncing: boolean
  /** Legacy sync-contract pull error. */
  syncError: unknown | null
  /** Force a delta refresh from the origin. */
  refetch: () => Promise<void>
}

/**
 * Read a page of a collection.
 *
 * ## The point
 *
 * Once the collection is **covered** — fully replicated for this scope — this hook
 * touches the network **zero times**. Filtering, sorting and paging are local
 * queries against the on-device database. Page 1 → page 2 → a new filter → page 47
 * → back to page 1: every one is a local read, instant and offline-capable.
 * Pagination stops being a network concern at all.
 *
 * That is the whole reason to put a real database on the device. A cache of API
 * pages could only ever answer the queries you already asked; a *covered replica*
 * answers queries nobody has asked yet.
 *
 * ## Before coverage lands
 *
 * On a cold start the replica is empty, and a SPA or React Native app has no server
 * render to paint behind. So the hook **bridges**: it fetches exactly the rows this
 * query needs and writes them into the same collection, under the same derived ids
 * the background walk will use. Those rows are not a cache entry to be reconciled
 * later — they are the replica, arriving early. When the walk reaches them it
 * overwrites them in place.
 *
 * @example
 * const { data, coverage } = useQuery<Product>({
 *   collection: 'products',
 *   filter: { category: 'kitchen', price: { $lt: 500 } },
 *   sort: { price: 1 },
 *   page: 2,
 *   limit: 100,
 * })
 */
export function useQuery<T extends Document>(options: UseQueryOptions<T>): QueryResult<T> {
  const { collection, filter, sort, page, limit, skip, enabled = true } = options

  const col = useCollection<T>(collection)
  const db = useTalaDB()
  const coverage = useCoverage(collection)
  const replication = useReplication()
  const coord = replication?.coordinators.get(collection)
  const legacyNetworked = !coord && options.source !== 'local-only'
  const { config: legacyConfig, pollMs } = useReplicationConfig(options)
  const legacyConfigRef = useRef<ResolvedReplicationConfig | null>(legacyConfig)
  legacyConfigRef.current = legacyConfig
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<unknown | null>(null)
  const [firstSyncDone, setFirstSyncDone] = useState(false)

  const legacyRefetch = useCallback(async (): Promise<void> => {
    const cfg = legacyConfigRef.current
    if (!legacyNetworked || !cfg) return
    setSyncing(true)
    setSyncError(null)
    try {
      await replicate(db, cfg, collection, 'pull')
    } catch (error) {
      setSyncError(error)
    } finally {
      setSyncing(false)
      setFirstSyncDone(true)
    }
  }, [db, collection, legacyNetworked, legacyConfig?.endpoint])

  useEffect(() => {
    if (!enabled || !legacyNetworked || !legacyConfig) return
    void legacyRefetch()
    if (pollMs > 0) {
      const timer = setInterval(() => void legacyRefetch(), pollMs)
      return () => clearInterval(timer)
    }
    return undefined
  }, [enabled, legacyNetworked, legacyConfig?.endpoint, pollMs, legacyRefetch])

  const offset = page !== undefined && limit !== undefined ? (page - 1) * limit : (skip ?? 0)

  // Serialised deps so inline `filter` / `sort` objects don't rebuild the pipeline
  // (and tear down the subscription) on every render.
  const filterKey = JSON.stringify(filter ?? null)
  const sortKey = JSON.stringify(sort ?? null)

  const [bridgeIds, setBridgeIds] = useState<string[]>([])
  const [fetchError, setFetchError] = useState<unknown | null>(null)
  const scopeValue = coord?.replicaScope
  const bridgeIdKey = (bridgeIds ?? []).join('|')

  const pipeline = useMemo<AggregatePipeline<T>>(() => {
    const stages: AggregatePipeline<T> = []
    const scoped = scopeValue ? ({ _replica_scope: scopeValue } as never) : undefined
    const bridgeOnly = !coverage.ready
      ? ({ _id: { $in: bridgeIds ?? [] } } as never)
      : undefined
    const matches = [scoped, bridgeOnly, filter].filter(Boolean)
    if (matches.length === 1) stages.push({ $match: matches[0] } as never)
    else if (matches.length > 1) stages.push({ $match: { $and: matches } } as never)
    if (sort) stages.push({ $sort: sort } as never)
    // A bridge already fetched the requested remote page. Applying the global
    // offset again to that partial set makes page 2 empty.
    if (coverage.ready && offset > 0) stages.push({ $skip: offset } as never)
    if (limit !== undefined) stages.push({ $limit: limit } as never)
    return stages
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, sortKey, offset, limit, coverage.ready, scopeValue, bridgeIdKey])

  // Live, not a snapshot: the page re-renders as hydration fills the collection
  // underneath it. Calling `aggregate` in an effect instead would leave the page
  // frozen — the spinner finishes and the rows never appear.
  const read = useAggregate<T, T>(col, enabled ? pipeline : ([{ $limit: 0 }] as never))

  const [fetching, setFetching] = useState(false)

  // Bridge: while the replica is not authoritative, serve this query from the
  // origin. Keyed on the query itself, and deduped inside the coordinator, so two
  // components asking for the same page fire one request.
  const bridgeKey = `${collection}|${filterKey}|${sortKey}|${offset}|${limit}`
  const canBridge = replication?.scopes[collection]?.bridge !== false

  useEffect(() => {
    if (!enabled || coverage.ready || !canBridge) return
    if (!coord) return

    let cancelled = false
    setFetching(true)
    setFetchError(null)
    setBridgeIds([])
    void coord
      .bridge({
        filter: filter as Record<string, unknown> | undefined,
        sort: sort as Record<string, 1 | -1> | undefined,
        page,
        limit,
      })
      .then((result) => setBridgeIds(result.ids ?? []))
      .catch((error) => {
        if (!cancelled) setFetchError(error)
      })
      .finally(() => {
        if (!cancelled) setFetching(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeKey, coverage.ready, canBridge, enabled, coord])

  const refetch = async (): Promise<void> => {
    if (coord) await coord.refresh()
    else await legacyRefetch()
  }

  if (enabled && legacyNetworked && !legacyConfig) {
    throw new Error(
      `useQuery({ collection: '${collection}' }) needs either a coverage-first replicate scope ` +
        `or a legacy sync endpoint. Use source: 'local-only' for a purely local query.`,
    )
  }

  return {
    data: read.data,
    total: coverage.total,
    loading:
      options.source === 'remote-first' && legacyNetworked
        ? read.loading || !firstSyncDone
        : read.loading,
    error: read.error ?? fetchError,
    fetchError,
    coverage,
    fetching,
    syncing,
    syncError,
    refetch,
  }
}
