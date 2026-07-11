import { useEffect, useRef, useState } from 'react'
import type { Document, Filter } from 'taladb'
import { useTalaDB } from './context'
import { useReplicationBase, resolveReplicationConfig } from './replication/config'
import { replicate } from './replication/engine'
import type { QueryResult, UseQueryOptions } from './useQuery'

const NOOP_REFETCH = async (): Promise<void> => {}

function emptyResult<T>(): QueryResult<T> {
  return { data: [], loading: true, error: null, syncing: false, syncError: null, refetch: NOOP_REFETCH }
}

/**
 * Run several scoped queries at once — one replication + live query per entry,
 * in parallel. The result array is index-aligned with `queries`.
 *
 * Each entry is an independent `useQuery`: its own collection, filter, source,
 * and (optionally) endpoint. This is the multi-slice page case — e.g. a
 * dashboard that needs `orders` and `products` from the same origin. There are
 * no cross-collection joins (TalaDB is a document store); compose in the
 * component.
 *
 * v1 note: entries are typed as `Document`. For a strictly-typed single slice
 * use `useQuery<T>`; per-entry generics (tuple typing) are a follow-up.
 *
 * @example
 * const [orders, products] = useQueries([
 *   { collection: 'orders', filter: { open: true } },
 *   { collection: 'products' },
 * ])
 */
export function useQueries(queries: UseQueryOptions<Document>[]): QueryResult<Document>[] {
  const db = useTalaDB()
  const base = useReplicationBase()

  // Fail fast (in render) if any networked entry has no resolvable endpoint —
  // consistent with useQuery, and before the effect wires anything up.
  for (const q of queries) {
    const networked = (q.source ?? 'local-first') !== 'local-only'
    if (networked && !(q.endpoint ?? base?.endpoint)) {
      throw new Error(
        `useQueries: the query for '${q.collection}' needs an endpoint for source ` +
          `'${q.source ?? 'local-first'}'. Provide <ReplicationProvider endpoint="…">, ` +
          'pass { endpoint }, or use source: "local-only".',
      )
    }
  }

  // Re-establish subscriptions/replications only when the set of queries
  // meaningfully changes (collection, filter, source, endpoint, pollMs).
  const sig = JSON.stringify(
    queries.map((q) => ({
      collection: q.collection,
      filter: q.filter ?? null,
      source: q.source ?? 'local-first',
      endpoint: q.endpoint ?? null,
      pollMs: q.pollMs ?? null,
    })),
  )

  const queriesRef = useRef(queries)
  queriesRef.current = queries
  const baseRef = useRef(base)
  baseRef.current = base

  const [results, setResults] = useState<QueryResult<Document>[]>(() =>
    queries.map(() => emptyResult<Document>()),
  )

  useEffect(() => {
    const qs = queriesRef.current
    const b = baseRef.current
    let cancelled = false

    const setAt = (i: number, fn: (r: QueryResult<Document>) => QueryResult<Document>) => {
      setResults((prev) => {
        if (i >= prev.length) return prev
        const copy = prev.slice()
        copy[i] = fn(copy[i])
        return copy
      })
    }

    const resolved = qs.map((q, i) => {
      const { config } = resolveReplicationConfig(b, {
        endpoint: q.endpoint,
        getAuth: q.getAuth,
        fetch: q.fetch,
        paths: q.paths,
        pollMs: q.pollMs,
      })
      const networked = (q.source ?? 'local-first') !== 'local-only'
      const pollMs = q.pollMs ?? b?.pollMs ?? 0
      const refetch = async (): Promise<void> => {
        if (!networked || !config) return
        setAt(i, (r) => ({ ...r, syncing: true, syncError: null }))
        try {
          await replicate(db, config, q.collection, 'pull')
        } catch (e) {
          if (!cancelled) setAt(i, (r) => ({ ...r, syncError: e }))
        } finally {
          if (!cancelled) setAt(i, (r) => ({ ...r, syncing: false }))
        }
      }
      return { config, networked, pollMs, refetch }
    })

    // Seed result slots with the per-entry refetch handles.
    setResults(
      qs.map((_q, i) => ({
        data: [],
        loading: true,
        error: null,
        syncing: false,
        syncError: null,
        refetch: resolved[i].refetch,
      })),
    )

    const unsubs = qs.map((q, i) => {
      const col = db.collection<Document>(q.collection)
      return col.subscribe(
        (q.filter ?? {}) as Filter<Document>,
        (docs) => {
          if (!cancelled) setAt(i, (r) => ({ ...r, data: docs, loading: false, error: null }))
        },
        (error) => {
          if (!cancelled) setAt(i, (r) => ({ ...r, loading: false, error }))
        },
      )
    })

    const intervals: ReturnType<typeof setInterval>[] = []
    resolved.forEach((res) => {
      if (!res.networked || !res.config) return
      void res.refetch()
      if (res.pollMs > 0) intervals.push(setInterval(() => void res.refetch(), res.pollMs))
    })

    return () => {
      cancelled = true
      unsubs.forEach((u) => u())
      intervals.forEach((id) => clearInterval(id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, sig])

  // Always return an array index-aligned with the current `queries`, even on the
  // render right after the list length changes (before the effect re-seeds).
  return queries.map((_q, i) => results[i] ?? emptyResult<Document>())
}
