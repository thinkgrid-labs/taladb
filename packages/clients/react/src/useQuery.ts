import { useCallback, useEffect, useRef, useState } from 'react'
import type { Document, Filter } from 'taladb'
import { useCollection } from './useCollection'
import { useFind } from './useFind'
import { useTalaDB } from './context'
import { useReplicationConfig, type ReplicationConfig } from './replication/config'
import { replicate, type ResolvedReplicationConfig } from './replication/engine'

/**
 * How a `useQuery` combines the local replica with the remote origin.
 * *(`remote-only` is a planned addition; the durable-replica model makes it a
 * rare escape hatch.)*
 */
export type ReadSource = 'local-first' | 'remote-first' | 'local-only'

export interface UseQueryOptions<T extends Document>
  extends Partial<Pick<ReplicationConfig, 'endpoint' | 'getAuth' | 'fetch' | 'paths' | 'pollMs'>> {
  /** Collection name — replicated as a whole; the `filter` narrows locally. */
  collection: string
  /** Live filter over the local collection. Inline objects are safe. */
  filter?: Filter<T>
  /**
   * - `local-first` *(default)* — serve local immediately; refresh in the
   *   background, and the live query re-renders when the pull lands.
   * - `remote-first` — stay `loading` until the first pull completes, then serve.
   * - `local-only` — never touch the network (no endpoint required).
   */
  source?: ReadSource
}

export interface QueryResult<T> {
  /** Current matching documents from the local replica. Reactive. */
  data: T[]
  /** First local snapshot pending — plus the first pull, for `remote-first`. */
  loading: boolean
  /** Most recent local-read error. */
  error: unknown | null
  /** A background replication pass is in flight. */
  syncing: boolean
  /** Most recent replication error (the local data is still served). */
  syncError: unknown | null
  /** Trigger a pull now. No-op for `local-only`. */
  refetch: () => Promise<void>
}

/**
 * Bind a component to a slice of a remote origin, backed by the local replica.
 *
 * The read is a live query over the local collection (`useFind`); the network
 * pull writes into that same collection, so the live query re-renders on its
 * own — one-way data flow, no `queryKey`, no `invalidateQueries`. See
 * `docs/scoped-replication.md`.
 *
 * @example
 * const { data, loading, syncing } = useQuery<Product>({
 *   collection: 'products',
 *   filter: { category: 'kitchen' },
 *   pollMs: 30_000,
 * })
 */
export function useQuery<T extends Document>(options: UseQueryOptions<T>): QueryResult<T> {
  const { collection, filter, source = 'local-first' } = options
  const networked = source !== 'local-only'

  const db = useTalaDB()
  const col = useCollection<T>(collection)
  const read = useFind<T>(col, filter)

  const { config, pollMs } = useReplicationConfig({
    endpoint: options.endpoint,
    getAuth: options.getAuth,
    fetch: options.fetch,
    paths: options.paths,
    pollMs: options.pollMs,
  })

  // Keep the latest config in a ref so `refetch` stays referentially stable
  // across renders (the config object identity changes every render, but its
  // meaning is captured by the stable `endpoint` dep below).
  const configRef = useRef<ResolvedReplicationConfig | null>(config)
  configRef.current = config

  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<unknown | null>(null)
  const [firstSyncDone, setFirstSyncDone] = useState(false)

  const endpoint = config?.endpoint

  const refetch = useCallback(async (): Promise<void> => {
    const cfg = configRef.current
    if (!networked || !cfg) return
    setSyncing(true)
    setSyncError(null)
    try {
      await replicate(db, cfg, collection, 'pull')
    } catch (e) {
      setSyncError(e)
    } finally {
      setSyncing(false)
      setFirstSyncDone(true)
    }
    // `endpoint` (a stable string) stands in for the config object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, collection, networked, endpoint])

  useEffect(() => {
    if (!networked) return
    void refetch()
    if (pollMs > 0) {
      const id = setInterval(() => void refetch(), pollMs)
      return () => clearInterval(id)
    }
    return undefined
  }, [refetch, networked, pollMs])

  // Fail fast with a clear message if a networked source has no endpoint. Placed
  // after all hooks so hook order is identical on every render.
  if (networked && !config) {
    throw new Error(
      `useQuery({ collection: '${collection}' }) needs an endpoint for source '${source}'. ` +
        'Wrap the tree in <ReplicationProvider endpoint="…">, pass { endpoint }, or use source: "local-only".',
    )
  }

  const loading = source === 'remote-first' ? read.loading || !firstSyncDone : read.loading

  return { data: read.data, loading, error: read.error, syncing, syncError, refetch }
}
