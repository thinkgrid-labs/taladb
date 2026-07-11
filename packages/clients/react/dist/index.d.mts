import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';
import { TalaDB, OpenDBOptions, Document, Collection, Filter } from 'taladb';

type TalaDBProviderProps = {
    children: ReactNode;
} & ({
    /** A TalaDB instance you opened yourself with `openDB()`. */
    db: TalaDB;
    name?: never;
    options?: never;
    fallback?: never;
} | {
    /**
     * Database name — the provider owns the `openDB(name)` lifecycle:
     * it opens lazily on the client (never during SSR), provides the handle
     * once ready, and closes it on unmount. The natural form for Next.js,
     * where `openDB` cannot run during server rendering.
     */
    name: string;
    /** Options forwarded to `openDB(name, options)` (e.g. inline sync config). */
    options?: OpenDBOptions;
    /**
     * Rendered while the database is opening (and during SSR).
     * Defaults to `null`. Children only render once the db is ready, so
     * `useTalaDB()` never observes a missing instance.
     */
    fallback?: ReactNode;
    db?: never;
});
/**
 * Provides a TalaDB instance to all child hooks.
 *
 * Two forms:
 *
 * **Instance form** — you own the lifecycle (plain React, React Native):
 * ```tsx
 * const db = await openDB('myapp.db')
 * <TalaDBProvider db={db}>…</TalaDBProvider>
 * ```
 *
 * **Name form** — the provider owns the lifecycle (recommended for Next.js):
 * ```tsx
 * <TalaDBProvider name="myapp.db" fallback={<Splash />}>…</TalaDBProvider>
 * ```
 * The database opens client-side only; during SSR (and while opening) the
 * `fallback` renders instead of children, so hooks always see a ready db.
 */
declare function TalaDBProvider(props: TalaDBProviderProps): react_jsx_runtime.JSX.Element;
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
    /** Most recent subscription error, cleared by the next successful snapshot. */
    error: unknown | null;
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
    /** Most recent subscription error, cleared by the next successful snapshot. */
    error: unknown | null;
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

/** Resolved network configuration for one replicated slice. */
interface ResolvedReplicationConfig {
    /** Base URL; `/push` and `/pull` are appended by {@link HttpSyncAdapter}. */
    endpoint: string;
    /**
     * Async (or sync) resolver for per-request headers — typically the
     * `Authorization` bearer. Called **once per pass, at send time**, so a token
     * that refreshed while a write sat in the local database is picked up when the
     * write finally flushes.
     */
    getAuth?: () => Promise<Record<string, string>> | Record<string, string>;
    /** `fetch` implementation. Defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Override the `/push` and `/pull` sub-paths to match an existing API. */
    paths?: {
        push?: string;
        pull?: string;
    };
}

/** A slice to warm on first run — a collection, optionally on a specific endpoint. */
type PrefetchSlice = {
    collection: string;
    endpoint?: string;
};
/** A prefetch entry: a collection name (shorthand) or a {@link PrefetchSlice}. */
type PrefetchEntry = string | PrefetchSlice;
/** `'once'` warms a slice only if it has never synced; `'always'` on every mount. */
type PrefetchMode = 'once' | 'always';
/**
 * Replication settings shared by `useQuery` / `useMutation`, supplied once by
 * `<ReplicationProvider>` and overridable per hook.
 *
 * The origin is *your* API — never a database credential. It authorizes the
 * session token from {@link ReplicationConfig.getAuth} and returns only that
 * user's slice, so the auth header doubles as the per-user scope.
 */
interface ReplicationConfig {
    /** Base sync URL, e.g. `/api/sync`. `/push` and `/pull` are appended. */
    endpoint: string;
    /**
     * Per-request header resolver — typically `{ Authorization: 'Bearer …' }`.
     * Async so it can await a token refresh. Resolved at **send time**, once per
     * pass, so an offline write flushed later carries a current token.
     */
    getAuth?: () => Promise<Record<string, string>> | Record<string, string>;
    /** `fetch` implementation. Defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Override the `/push` and `/pull` sub-paths to match an existing API. */
    paths?: {
        push?: string;
        pull?: string;
    };
    /**
     * Default background refresh interval (ms) for `useQuery`. A replication
     * *interval*, not a cache TTL — the local data is never evicted, only
     * refreshed. Omit or set `0` to disable polling by default; a hook can still
     * opt in per query. `30_000` matches the guide's own example cadence.
     */
    pollMs?: number;
    /**
     * Slices to warm into the local replica in the background on first run, so a
     * later `useQuery` for that collection reads local instead of waiting on the
     * network. Best-effort and non-blocking: deferred to browser idle, run in the
     * sync Worker on web, and silently skipped on failure. Each entry is a
     * collection name or a {@link PrefetchSlice}.
     */
    prefetch?: PrefetchEntry[];
    /** How prefetch decides to warm a slice. Default `'once'`. */
    prefetchMode?: PrefetchMode;
    /** Max concurrent prefetch pulls — keeps the active page from starving. Default `2`. */
    prefetchConcurrency?: number;
}
interface ReplicationProviderProps extends ReplicationConfig {
    children: ReactNode;
}
/**
 * Supplies replication defaults (endpoint, auth, poll interval, prefetch) to the
 * `useQuery` / `useMutation` hooks below it. Compose it inside a
 * `<TalaDBProvider>`:
 *
 * ```tsx
 * <TalaDBProvider name="app.db" fallback={<Splash />}>
 *   <ReplicationProvider
 *     endpoint="/api/sync"
 *     getAuth={async () => ({ Authorization: `Bearer ${await session.token()}` })}
 *     pollMs={30_000}
 *     prefetch={['products', 'categories']}
 *   >
 *     <App />
 *   </ReplicationProvider>
 * </TalaDBProvider>
 * ```
 */
declare function ReplicationProvider({ children, ...config }: ReplicationProviderProps): react_jsx_runtime.JSX.Element;
/**
 * Read the nearest replication config, merged with per-hook overrides.
 * Non-throwing: `config` is `null` when no endpoint is resolvable (valid for
 * `source: 'local-only'`); the caller decides whether that's an error.
 */
declare function useReplicationConfig(overrides?: Partial<ReplicationConfig>): {
    config: ResolvedReplicationConfig | null;
    pollMs: number;
};

/**
 * How a `useQuery` combines the local replica with the remote origin.
 * *(`remote-only` is a planned addition; the durable-replica model makes it a
 * rare escape hatch.)*
 */
type ReadSource = 'local-first' | 'remote-first' | 'local-only';
interface UseQueryOptions<T extends Document> extends Partial<Pick<ReplicationConfig, 'endpoint' | 'getAuth' | 'fetch' | 'paths' | 'pollMs'>> {
    /** Collection name — replicated as a whole; the `filter` narrows locally. */
    collection: string;
    /** Live filter over the local collection. Inline objects are safe. */
    filter?: Filter<T>;
    /**
     * - `local-first` *(default)* — serve local immediately; refresh in the
     *   background, and the live query re-renders when the pull lands.
     * - `remote-first` — stay `loading` until the first pull completes, then serve.
     * - `local-only` — never touch the network (no endpoint required).
     */
    source?: ReadSource;
}
interface QueryResult<T> {
    /** Current matching documents from the local replica. Reactive. */
    data: T[];
    /** First local snapshot pending — plus the first pull, for `remote-first`. */
    loading: boolean;
    /** Most recent local-read error. */
    error: unknown | null;
    /** A background replication pass is in flight. */
    syncing: boolean;
    /** Most recent replication error (the local data is still served). */
    syncError: unknown | null;
    /** Trigger a pull now. No-op for `local-only`. */
    refetch: () => Promise<void>;
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
declare function useQuery<T extends Document>(options: UseQueryOptions<T>): QueryResult<T>;

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
declare function useQueries(queries: UseQueryOptions<Document>[]): QueryResult<Document>[];

/** A single write intent against the local replica. Discriminated on `type`. */
type WriteOp<T extends Document> = {
    type: 'insert';
    doc: Omit<T, '_id'>;
} | {
    type: 'update';
    where: Filter<T>;
    set: Partial<Omit<T, '_id'>>;
} | {
    type: 'delete';
    where: Filter<T>;
};
interface UseMutationOptions extends Partial<Pick<ReplicationConfig, 'endpoint' | 'getAuth' | 'fetch' | 'paths'>> {
    /** Collection the write targets. */
    collection: string;
    /**
     * Replication direction for the drain. `push` *(default)* sends the write;
     * read hooks reconcile the authoritative value on their next pull. `both`
     * also pulls the authoritative echo inline (heavier — replays the collection).
     */
    direction?: 'push' | 'both';
    /**
     * On mount, attempt to flush any local writes left unsent from a previous
     * (offline) session for this collection. Default `true`.
     */
    drainOnMount?: boolean;
}
interface MutationResult<T extends Document> {
    /** Fire-and-forget write. Errors surface on `error`, never thrown to render. */
    mutate: (op: WriteOp<T>) => void;
    /** Awaitable write. Resolves once the local write and drain settle; rejects on error. */
    mutateAsync: (op: WriteOp<T>) => Promise<void>;
    /** A write (local + drain) is in flight. */
    pending: boolean;
    /** Most recent write/drain error. The local write is durable regardless. */
    error: unknown | null;
}
/**
 * Local-first write hook. A mutation writes the local replica **first**
 * (immediate, durable, reactive — every `useQuery`/`useFind` on the collection
 * re-renders) and then replicates the change outward over the sync-contract with
 * bounded retry. The network step never rolls the local write back: it is
 * already committed, and a later drain still delivers it (write-behind).
 *
 * Write-authority is origin-authoritative by default — the push sends the
 * change and the server is the arbiter; read hooks pull the authoritative value.
 *
 * @example
 * const { mutate, pending } = useMutation<Order>({ collection: 'orders' })
 * mutate({ type: 'update', where: { _id }, set: { status: 'shipped' } })
 */
declare function useMutation<T extends Document>(options: UseMutationOptions): MutationResult<T>;

export { type FindOneResult, type FindResult, type MutationResult, type PrefetchEntry, type PrefetchMode, type PrefetchSlice, type QueryResult, type ReadSource, type ReplicationConfig, ReplicationProvider, type ReplicationProviderProps, TalaDBProvider, type TalaDBProviderProps, type UseMutationOptions, type UseQueryOptions, type WriteOp, useCollection, useFind, useFindOne, useMutation, useQueries, useQuery, useReplicationConfig, useTalaDB };
