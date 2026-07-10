import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';
import { TalaDB, Document, Collection, Filter } from 'taladb';

interface TalaDBProviderProps {
    /** The TalaDB instance returned by `openDB()`. */
    db: TalaDB;
    children: ReactNode;
}
/**
 * Provides a TalaDB instance to all child hooks.
 *
 * @example
 * const db = await openDB('myapp.db')
 *
 * function App() {
 *   return (
 *     <TalaDBProvider db={db}>
 *       <MyComponent />
 *     </TalaDBProvider>
 *   )
 * }
 */
declare function TalaDBProvider({ db, children }: TalaDBProviderProps): react_jsx_runtime.JSX.Element;
/**
 * Returns the TalaDB instance from the nearest `<TalaDBProvider>`.
 *
 * @throws If called outside of a `<TalaDBProvider>`.
 */
declare function useTalaDB(): TalaDB;

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
declare function useCollection<T extends Document>(name: string): Collection<T>;

interface FindResult<T> {
    /** The current matching documents. Empty array while loading. */
    data: T[];
    /** True until the first snapshot has been delivered from the database. */
    loading: boolean;
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
declare function useFind<T extends Document>(collection: Collection<T>, filter?: Filter<T>): FindResult<T>;

interface FindOneResult<T> {
    /** The first matching document, or `null` when none matched or still loading. */
    data: T | null;
    /** True until the first snapshot has been delivered from the database. */
    loading: boolean;
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
declare function useFindOne<T extends Document>(collection: Collection<T>, filter: Filter<T>): FindOneResult<T>;

export { type FindOneResult, type FindResult, TalaDBProvider, type TalaDBProviderProps, useCollection, useFind, useFindOne, useTalaDB };
