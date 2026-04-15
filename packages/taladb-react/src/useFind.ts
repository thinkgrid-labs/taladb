import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Collection, Document, Filter } from 'taladb'

export interface FindResult<T> {
  /** The current matching documents. Empty array while loading. */
  data: T[]
  /** True until the first snapshot has been delivered from the database. */
  loading: boolean
}

/**
 * Subscribe to a live query. Re-renders whenever the matching documents change.
 *
 * Backed by `useSyncExternalStore` for zero-tearing snapshots in concurrent React.
 * Works in both React (browser / Node.js) and React Native.
 *
 * @param collection  A `Collection<T>` instance (memoize or store outside the component).
 * @param filter      Optional filter. Inline objects are safe — the filter is
 *                    serialised to a string for subscription identity checks so
 *                    `{ active: true }` on every render does not re-subscribe.
 *
 * @example
 * const articles = useMemo(() => db.collection<Article>('articles'), [db])
 * const { data, loading } = useFind(articles, { locale: 'en' })
 */
export function useFind<T extends Document>(
  collection: Collection<T>,
  filter?: Filter<T>,
): FindResult<T> {
  // The current snapshot — replaced (new object) on each data update so
  // useSyncExternalStore detects changes via Object.is.
  const snapshotRef = useRef<FindResult<T>>({ data: [], loading: true })

  // Serialise filter to a stable string so inline filter objects (e.g.
  // `useFind(col, { active: true })`) don't re-subscribe on every render.
  const filterKey = JSON.stringify(filter ?? null)

  // subscribe is recreated only when collection or filterKey changes.
  // On each new subscription we reset to loading so the caller sees a
  // consistent loading → data transition when the filter changes.
  const subscribe = useCallback(
    (notify: () => void) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true }
      return collection.subscribe(filter, (docs: T[]) => {
        snapshotRef.current = { data: docs, loading: false }
        notify()
      })
    },
    // filterKey captures the serialised filter; collection is the identity dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, filterKey],
  )

  const getSnapshot = useCallback((): FindResult<T> => snapshotRef.current, [])

  // getSnapshot is also passed as getServerSnapshot so SSR (Next.js / Expo RSC)
  // returns the initial empty state rather than throwing.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
