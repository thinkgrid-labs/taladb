import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { AggregatePipeline, Collection, Document } from 'taladb'

export interface AggregateResult<R> {
  /** The current pipeline results. Empty while loading. */
  data: R[]
  /** True until the first snapshot has been delivered. */
  loading: boolean
  /** Most recent subscription error, cleared by the next successful snapshot. */
  error: unknown | null
}

/**
 * Subscribe to a **live aggregation**. Re-renders whenever the results change.
 *
 * This is the paging primitive. `find()` has no sort/skip/limit — only `aggregate`
 * does — but `aggregate` on its own returns a *dead snapshot*: call it in an effect
 * and the page sits frozen while a background hydration fills the collection
 * underneath it. The user watches a spinner finish and the rows never arrive.
 *
 * So anything that pages locally subscribes here rather than calling `aggregate`
 * directly.
 *
 * @param collection A `Collection<T>` (memoize it, or take it from `useCollection`).
 * @param pipeline   Inline arrays are safe — the pipeline is serialised for
 *                   subscription identity, so a fresh array each render does not
 *                   re-subscribe.
 *
 * @example
 * const page = useAggregate<Product, Product>(products, [
 *   { $match: { category: 'kitchen' } },
 *   { $sort: { price: 1 } },
 *   { $skip: 100 },
 *   { $limit: 100 },
 * ])
 */
export function useAggregate<T extends Document, R extends Document = T>(
  collection: Collection<T>,
  pipeline: AggregatePipeline<T>,
): AggregateResult<R> {
  const snapshotRef = useRef<AggregateResult<R>>({ data: [], loading: true, error: null })

  // Serialised so an inline pipeline array doesn't tear down the subscription on
  // every render — the same discipline `useFind` applies to inline filters.
  const pipelineKey = JSON.stringify(pipeline)

  const subscribe = useCallback(
    (notify: () => void) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true, error: null }
      return collection.subscribeAggregate<R>(
        pipeline,
        (docs) => {
          snapshotRef.current = { data: docs, loading: false, error: null }
          notify()
        },
        (error) => {
          snapshotRef.current = { ...snapshotRef.current, loading: false, error }
          notify()
        },
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, pipelineKey],
  )

  const getSnapshot = useCallback((): AggregateResult<R> => snapshotRef.current, [])

  // Also the server snapshot, so SSR renders the empty state rather than throwing.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
