import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';
import { CollectionOptions, Document, TalaDB, OpenDBOptions, Collection, Filter, AggregatePipeline, RestSourceOptions, ReplicationSource, CoverageState } from 'taladb';

/**
 * Per-collection options (`schema`, `syncSchema`, `migrateDocument`, …), keyed by
 * collection name.
 *
 * Register them once on the provider and every hook below it — `useCollection`,
 * and therefore `useFind`, `useQuery` and `useMutation` — resolves a *configured*
 * collection. Without this, those hooks call `db.collection(name)` with no
 * options, so a hook-driven write silently skips the strict `schema` validation
 * and the `_v` stamp that `db.collection(name, { … })` would have applied.
 */
type CollectionRegistry = Record<string, CollectionOptions<any>>;
/** Resolves the registered options for a collection. Stable across renders. */
interface CollectionResolver {
    get<T extends Document>(name: string): CollectionOptions<T> | undefined;
}
declare function useCollectionOptions(): CollectionResolver;
type SharedProps = {
    children: ReactNode;
    /**
     * Per-collection options, keyed by collection name — see {@link CollectionRegistry}.
     *
     * ```tsx
     * <TalaDBProvider
     *   name="app.db"
     *   collections={{
     *     bookings: { schema: BookingSchema, syncSchema: { version: 1 } },
     *   }}
     * >
     * ```
     * Treated as static configuration: read when a collection handle is first
     * created, so an inline object here does not thrash live queries.
     */
    collections?: CollectionRegistry;
};
type TalaDBProviderProps = SharedProps & ({
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
 * The collection is opened **with its registered options** — the `schema`,
 * `syncSchema` and `migrateDocument` declared in the provider's `collections`
 * prop, or the `options` passed here (which win). That is what makes a write
 * through `useMutation` hard-fail on an invalid document and carry its `_v`
 * shape version, exactly as `db.collection(name, { … })` does. Without it the
 * hooks resolve a bare, unconfigured handle and silently skip validation.
 *
 * The returned collection is memoised — the same object reference is returned on
 * every render unless the db instance or collection name changes. Pass it
 * directly to `useFind` or `useFindOne` without wrapping in `useMemo`. Options
 * are read when the handle is first created and treated as static configuration,
 * so an inline `{ schema }` object cannot thrash live-query subscriptions.
 *
 * @param name     The collection name (e.g. `'articles'`).
 * @param options  Per-call options; overrides the provider's registry entry.
 *
 * @example
 * // Registered once on the provider — every hook below it picks this up:
 * <TalaDBProvider name="app.db" collections={{ articles: { schema: Article } }}>
 *
 * const articles = useCollection<Article>('articles')
 * const { data, loading } = useFind(articles, { locale: 'en' })
 */
declare function useCollection<T extends Document>(name: string, options?: CollectionOptions<T>): Collection<T>;

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

interface AggregateResult<R> {
    /** The current pipeline results. Empty while loading. */
    data: R[];
    /** True until the first snapshot has been delivered. */
    loading: boolean;
    /** Most recent subscription error, cleared by the next successful snapshot. */
    error: unknown | null;
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
declare function useAggregate<T extends Document, R extends Document = T>(collection: Collection<T>, pipeline: AggregatePipeline<T>): AggregateResult<R>;

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

/** When the background hydration walk is allowed to start. */
type HydrateMode =
/** Immediately on mount. */
'eager'
/** When the browser is idle (default). Keeps first paint responsive. */
 | 'idle'
/** Never automatically — the app calls `hydrate()` itself. */
 | 'manual';
interface ReplicateScope<RemoteRow = any, T extends Document = Document> extends Omit<RestSourceOptions<RemoteRow, T>, 'collection'> {
    /**
     * Provide a fully custom source instead of the REST defaults. When present,
     * every other field here is ignored.
     */
    source?: ReplicationSource<RemoteRow, T>;
    hydrate?: HydrateMode;
    /** Rows per bootstrap page. Default 500. */
    pageSize?: number;
    /** Re-check the origin for changes on this interval. `0` disables. */
    refreshMs?: number;
    /**
     * Fetch the current query directly when coverage isn't ready yet, so a cold
     * start paints immediately. Default `true`.
     *
     * Mandatory in practice for a Vite SPA or React Native, which have no server
     * render to paint behind while the replica fills.
     */
    bridge?: boolean;
}
/** One entry per local collection. */
type ReplicateRegistry = Record<string, ReplicateScope<any, any>>;

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
interface ReplicationProviderProps extends Partial<ReplicationConfig> {
    /**
     * Collections to replicate from a remote origin, keyed by local collection name.
     *
     * This is what makes `useQuery` a local read: once a collection is fully
     * hydrated for its scope, filtering, sorting and paging never touch the network.
     * See {@link ReplicateRegistry}.
     */
    replicate?: ReplicateRegistry;
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
declare function ReplicationProvider({ children, replicate, ...config }: ReplicationProviderProps): react_jsx_runtime.JSX.Element;
/**
 * Read the nearest replication config, merged with per-hook overrides.
 * Non-throwing: `config` is `null` when no endpoint is resolvable (valid for
 * `source: 'local-only'`); the caller decides whether that's an error.
 */
declare function useReplicationConfig(overrides?: Partial<ReplicationConfig>): {
    config: ResolvedReplicationConfig | null;
    pollMs: number;
};

interface Coverage {
    /** The raw state machine value. */
    status: CoverageState['status'];
    /**
     * Whether a purely local read is authorized.
     *
     * True **only** for `complete`. Notably *not* for `best-effort`, which means we
     * applied every row the origin gave us but the origin could not pin a snapshot —
     * so a row that shifted between pages during the walk may never have been seen,
     * and we cannot prove the replica is whole. Serving that as authoritative would
     * silently return incomplete results, which is worse than going to the network.
     */
    ready: boolean;
    /** Rows hydrated so far. */
    rows: number;
    /** Total rows in scope when supplied by the origin. */
    total?: number;
    /** 0–1 when the origin reported a total; otherwise undefined. */
    progress?: number;
    /** Present on `error`, `stale` and `best-effort`. */
    reason?: string;
}
/**
 * How much of a collection is local, and whether it can be trusted for a
 * network-free read.
 *
 * @example
 * const { ready, progress } = useCoverage('products')
 * if (!ready) return <ProgressBar value={progress} />
 */
declare function useCoverage(collection: string): Coverage;
/** Semantic alias for progress-oriented UIs. */
declare const useHydrationProgress: typeof useCoverage;

type ReadSource = 'local-first' | 'remote-first' | 'local-only';
interface UseQueryOptions<T extends Document> extends Partial<Pick<ReplicationConfig, 'endpoint' | 'getAuth' | 'fetch' | 'paths' | 'pollMs'>> {
    /** The local collection to read. */
    collection: string;
    /** Mongo-style filter, applied **locally**. */
    filter?: Filter<T>;
    /** Sort, applied locally. `1` ascending, `-1` descending. */
    sort?: Partial<Record<keyof T & string, 1 | -1>>;
    /** 1-based page number. Requires `limit`. */
    page?: number;
    /** Rows per page. */
    limit?: number;
    /** Skip N rows. Ignored when `page` is set. */
    skip?: number;
    /** Skip the query entirely (e.g. while a route param is undefined). */
    enabled?: boolean;
    /** Legacy sync-contract read policy. Used when no full-replication scope exists. */
    source?: ReadSource;
}
interface QueryResult<T> {
    /** The current page. Reactive: re-renders as rows land. */
    data: T[];
    /** Total rows in the replicated scope when reported by the origin. */
    total?: number;
    /** True until the first local snapshot arrives. */
    loading: boolean;
    /** Most recent local read error. */
    error: unknown | null;
    /** Most recent cold-start bridge error. */
    fetchError: unknown | null;
    /** How much of the collection is local, and whether it is trustworthy. */
    coverage: Coverage;
    /**
     * A cold-start bridge fetch is in flight — we are serving the network because
     * the replica isn't complete yet.
     */
    fetching: boolean;
    /** Legacy sync-contract pull in progress. */
    syncing: boolean;
    /** Legacy sync-contract pull error. */
    syncError: unknown | null;
    /** Force a delta refresh from the origin. */
    refetch: () => Promise<void>;
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
declare function useQuery<T extends Document>(options: UseQueryOptions<T>): QueryResult<T>;

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

export { type AggregateResult, type CollectionRegistry, type CollectionResolver, type Coverage, type FindOneResult, type FindResult, type HydrateMode, type MutationResult, type PrefetchEntry, type PrefetchMode, type PrefetchSlice, type QueryResult, type ReplicateRegistry, type ReplicateScope, type ReplicationConfig, ReplicationProvider, type ReplicationProviderProps, TalaDBProvider, type TalaDBProviderProps, type UseMutationOptions, type UseQueryOptions, type WriteOp, useAggregate, useCollection, useCollectionOptions, useCoverage, useFind, useFindOne, useHydrationProgress, useMutation, useQueries, useQuery, useReplicationConfig, useTalaDB };
