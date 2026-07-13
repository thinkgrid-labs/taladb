import { useEffect, useMemo, useRef, useState } from 'react'
import type { AggregatePipeline, Document } from 'taladb'
import { useCollectionOptions, useTalaDB } from './context'
import { useReplication } from './replication/provider'
import type { Coverage } from './useCoverage'
import type { QueryResult, UseQueryOptions } from './useQuery'

/**
 * Several pages at once, from several collections. Index-aligned with `queries`.
 *
 * Hooks can't be called in a variable-length loop, so this manages its own
 * subscriptions rather than calling `useQuery` N times. Behaviour is otherwise
 * identical: once a collection is covered, its read is purely local.
 *
 * TalaDB is a document store with no cross-collection joins, so a page needing
 * several collections composes them in the component (or denormalises at the
 * origin). This is the hook for that.
 *
 * @example
 * const [products, categories] = useQueries([
 *   { collection: 'products', filter: { category }, sort: { price: 1 }, page, limit: 50 },
 *   { collection: 'categories' },
 * ])
 */
export function useQueries(queries: UseQueryOptions<Document>[]): QueryResult<Document>[] {
  const db = useTalaDB()
  const registry = useCollectionOptions()
  const replication = useReplication()

  const [results, setResults] = useState<
    Array<{ data: Document[]; loading: boolean; error: unknown }>
  >(() => queries.map(() => ({ data: [], loading: true, error: null })))
  const [bridgeIds, setBridgeIds] = useState<Record<number, string[]>>({})
  const [fetchErrors, setFetchErrors] = useState<Record<number, unknown>>({})

  // Re-wire only when the queries actually change — not on every render, or an
  // inline array would tear down every subscription each time.
  const signature = JSON.stringify(
    queries.map((q) => ({
      collection: q.collection,
      filter: q.filter ?? null,
      sort: q.sort ?? null,
      page: q.page ?? null,
      limit: q.limit ?? null,
      skip: q.skip ?? null,
      enabled: q.enabled ?? true,
    })),
  )
  const latest = useRef(queries)
  latest.current = queries
  const bridgeManifestKey = JSON.stringify(bridgeIds)
  const replicationReadKey = JSON.stringify(
    queries.map((q) => ({
      scope: replication?.coordinators.get(q.collection)?.replicaScope ?? null,
      ready: replication?.coverage[q.collection]?.status === 'complete',
    })),
  )

  useEffect(() => {
    const current = latest.current
    setResults(current.map(() => ({ data: [], loading: true, error: null })))

    const unsubs = current.map((q, i) => {
      if (q.enabled === false) return () => {}

      // Resolved through the collection registry, so schema validation and
      // migrations apply — the same handle `useCollection` would give you. The
      // previous implementation called `db.collection(name)` bare here and
      // silently skipped both.
      const col = db.collection<Document>(q.collection, registry.get(q.collection))

      const offset =
        q.page !== undefined && q.limit !== undefined ? (q.page - 1) * q.limit : (q.skip ?? 0)
      const pipeline: AggregatePipeline<Document> = []
      const coord = replication?.coordinators.get(q.collection)
      const covered = replication?.coverage[q.collection]?.status === 'complete'
      const matches = [
        coord ? { _replica_scope: coord.replicaScope } : undefined,
        !covered ? { _id: { $in: bridgeIds[i] ?? [] } } : undefined,
        q.filter,
      ].filter(Boolean)
      if (matches.length === 1) pipeline.push({ $match: matches[0] } as never)
      else if (matches.length > 1) pipeline.push({ $match: { $and: matches } } as never)
      if (q.sort) pipeline.push({ $sort: q.sort } as never)
      if (covered && offset > 0) pipeline.push({ $skip: offset } as never)
      if (q.limit !== undefined) pipeline.push({ $limit: q.limit } as never)

      // Live, not a snapshot: each page re-renders as hydration fills its
      // collection underneath it.
      return col.subscribeAggregate<Document>(
        pipeline,
        (docs) =>
          setResults((prev) => {
            const next = [...prev]
            next[i] = { data: docs, loading: false, error: null }
            return next
          }),
        (error) =>
          setResults((prev) => {
            const next = [...prev]
            next[i] = { ...next[i]!, loading: false, error }
            return next
          }),
      )
    })

    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, registry, signature, replicationReadKey, bridgeManifestKey])

  // Cold-start bridge for any collection that isn't covered yet. Deduped inside
  // the coordinator, so overlapping queries fire one request.
  useEffect(() => {
    for (const [i, q] of latest.current.entries()) {
      if (q.enabled === false) continue
      const coord = replication?.coordinators.get(q.collection)
      if (!coord || replication?.scopes[q.collection]?.bridge === false) continue
      void coord.getCoverage().then((state) => {
        if (state.status === 'complete') return
        return coord
          .bridge({
            filter: q.filter as Record<string, unknown> | undefined,
            sort: q.sort as Record<string, 1 | -1> | undefined,
            page: q.page,
            limit: q.limit,
          })
          .then((result) => {
            setBridgeIds((prev) => ({ ...prev, [i]: result.ids }))
            setFetchErrors((prev) => {
              const next = { ...prev }
              delete next[i]
              return next
            })
          })
          .catch((error) => setFetchErrors((prev) => ({ ...prev, [i]: error })))
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replication, signature])

  return useMemo(
    () =>
      latest.current.map((q, i) => {
        const state = replication?.coverage[q.collection] ?? { status: 'empty' as const }
        const coverage: Coverage = {
          status: state.status,
          // Only `complete` licenses a local-only read — see `useCoverage`.
          ready: state.status === 'complete',
          rows: 'rowsApplied' in state ? (state.rowsApplied ?? 0) : 0,
          total: 'total' in state ? state.total : undefined,
          progress: state.status === 'complete' ? 1 : undefined,
          reason:
            state.status === 'error'
              ? state.error
              : state.status === 'best-effort' || state.status === 'stale'
                ? state.reason
                : undefined,
        }
        return {
          data: results[i]?.data ?? [],
          total: coverage.total,
          loading: results[i]?.loading ?? true,
          error: results[i]?.error ?? fetchErrors[i] ?? null,
          fetchError: fetchErrors[i] ?? null,
          coverage,
          fetching: false,
          syncing: false,
          syncError: null,
          refetch: async () => {
            await replication?.coordinators.get(q.collection)?.refresh()
          },
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, signature, replication],
  )
}
