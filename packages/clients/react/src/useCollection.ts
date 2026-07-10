import { useMemo } from 'react'
import type { Collection, Document } from 'taladb'
import { useTalaDB } from './context'

/**
 * Returns a stable `Collection<T>` handle from the nearest `<TalaDBProvider>`.
 *
 * The returned collection is memoised — the same object reference is returned
 * on every render unless the db instance or collection name changes. Pass it
 * directly to `useFind` or `useFindOne` without wrapping in `useMemo`.
 *
 * @param name  The collection name (e.g. `'articles'`).
 *
 * @example
 * const articles = useCollection<Article>('articles')
 * const { data, loading } = useFind(articles, { locale: 'en' })
 */
export function useCollection<T extends Document>(name: string): Collection<T> {
  const db = useTalaDB()
  return useMemo(() => db.collection<T>(name), [db, name])
}
