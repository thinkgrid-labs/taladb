import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Collection, Document, Filter } from 'taladb'

export interface FindOneResult<T> {
  /** The first matching document, or `null` when none matched or still loading. */
  data: T | null
  /** True until the first snapshot has been delivered from the database. */
  loading: boolean
}

/**
 * Subscribe to a single document live query. Re-renders when the matching
 * document changes.
 *
 * Internally subscribes with the same filter as `useFind` and returns the
 * first result. If you need all matching documents use `useFind` instead.
 *
 * @param collection  A `Collection<T>` instance.
 * @param filter      Filter to identify the document. Inline objects are safe.
 *
 * @example
 * const users = useMemo(() => db.collection<User>('users'), [db])
 * const { data: user, loading } = useFindOne(users, { _id: userId })
 */
export function useFindOne<T extends Document>(
  collection: Collection<T>,
  filter: Filter<T>,
): FindOneResult<T> {
  const snapshotRef = useRef<FindOneResult<T>>({ data: null, loading: true })
  const filterKey = JSON.stringify(filter)

  const subscribe = useCallback(
    (notify: () => void) => {
      snapshotRef.current = { data: snapshotRef.current.data, loading: true }
      return collection.subscribe(filter, (docs: T[]) => {
        snapshotRef.current = { data: docs[0] ?? null, loading: false }
        notify()
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, filterKey],
  )

  const getSnapshot = useCallback((): FindOneResult<T> => snapshotRef.current, [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
