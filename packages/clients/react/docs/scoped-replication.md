# Design: Scoped Replication Hooks for `@taladb/react`

**Status:** Draft / proposal — no implementation yet.
**Scope:** New react-query-shaped hooks (`useQuery`, `useQueries`, `useMutation`) that bind a component or route to a *slice* of a remote origin, backed by the local TalaDB database.
**Relationship to existing work:** An ergonomic, per-component surface **onto the existing replication/sync layer** — not a second data system. Expands the roadmap item *HTTP sync — configurable push batching & pull interval* (`docs/roadmap.md`).

---

## 1. The one framing that governs everything: replica, not cache

This layer looks like TanStack Query, so the temptation is to call the local store a "cache." **It is not a cache, and we must not call it one.**

| | Cache (react-query, Apollo) | Replica (TalaDB) |
|---|---|---|
| Lifetime | Disposable, evictable | Durable, never auto-evicted |
| Source of truth | Always the server | Origin *or* local, declared per collection |
| Offline | Degrades / empties | First-class reads **and** writes |
| On "invalidate" | Drop the entry | Refetch and overwrite — **never delete** |

The local data is a **replica**: a durable, queryable, offline-authoritative copy that stays in sync with an origin. Once a document is local, it is real data — not a projection that can be thrown away. This is the CouchDB / PouchDB / RxDB lineage TalaDB already sits in.

Consequences that fall out of this word and must hold in the implementation:

- The read path **hydrates a real collection** from a remote source on first use. It does not "fill a cache on miss."
- Nothing auto-evicts. Data only **refreshes** (refetch → overwrite) or is **marked stale**. There is no TTL-driven deletion pass — such a pass would delete real user data.
- The "cache" and the "data" are the **same collection**. `useQuery({ collection: 'products' })` writes into the real `products` collection, not a shadow store. So *invalidate ≡ refetch-and-overwrite*, never *drop*.
- The write path is a durable local write **plus** replicate-out, not a "write-behind cache flush."

We keep the hook *names* `useQuery` / `useMutation` for familiarity, but every doc comment states plainly: **these bind your real local collections to a remote origin; the local data is a replica, not a cache.**

---

## 2. Why this exists (motivation)

Today `@taladb/react` gives you reactive local reads (`useFind` / `useFindOne` over `collection.subscribe`), and the sync layer gives you `db.sync(adapter, { collections, direction })` — a single, **global, imperative** replication pass. That leaves a gap:

- Different routes need **different slices** of the origin at different times. A product page needs `products` where `category = 'x'`; a dashboard needs `orders` for the last 30 days. `db.sync()` replicates everything (or coarse per-collection allow/deny lists), on a cadence the app hand-rolls with `setInterval`.
- React developers expect **declarative, per-component data dependencies** — the Apollo/GraphQL insight — not an imperative sync call wired into route effects.

So the new capability is **scoped, declarative, on-demand replication**: a component declares "I need this slice of this origin," and the hook keeps that slice replicated into local while the component is mounted. It is the same replication concept as `db.sync()`, just per-view and fetch-on-demand instead of global-and-imperative.

**Non-goal:** replacing `db.sync()` or the `SyncAdapter` interface. Those stay. This is sugar on top.

---

## 3. The core mechanic: one-way data flow

The single most important design rule. A naïve implementation would fetch remote data and hand it back to the component as state, in parallel with the local read. **Don't.** The network result never becomes component state. It is **written into the local collection**, and the existing live query re-renders off that write.

```
                 ┌─────────────────────────────────────────┐
   remote origin │  GET /api/products?category=x            │
                 └───────────────────┬─────────────────────┘
                                     │  upsert into collection
                                     ▼
   ┌───────────────────────────────────────────────────────┐
   │  local TalaDB collection 'products'  (the replica)     │
   └───────────────────┬───────────────────────────────────┘
                       │  collection.subscribe fires
                       ▼
   ┌───────────────────────────────────────────────────────┐
   │  useFind → useSyncExternalStore → component re-renders │
   └───────────────────────────────────────────────────────┘
```

So `useQuery` is, conceptually:

```ts
function useQuery({ collection, filter, source, ...net }) {
  const col = useCollection(collection)
  useReplicateSlice(col, { filter, source, ...net })  // network → upsert into col
  return useFind(col, filter)                           // reactive local read
}
```

**The payoff, and the headline of the feature:** there is no `queryKey` and no `invalidateQueries`. In react-query a mutation forces you to manually invalidate every dependent query key. Here, a write to a collection is observed by *every* `useQuery` / `useFind` watching it — they re-render automatically. Writing to the replica **is** the invalidation. We delete an entire category of react-query ceremony, and we should say so loudly: the local-first version is not just different, it is **simpler**.

---

## 4. Read modes (`source`)

Named away from cache vocabulary. One option controls how local and remote combine on read:

| `source` | Behavior |
|---|---|
| `'local-first'` *(default)* | Serve local immediately. Replicate in the background; live query updates when writes land. (The everyday offline-friendly path.) |
| `'remote-first'` | Always replicate first; render once the slice is fresh (still writes through to local). Use when staleness is unacceptable. |
| `'local-only'` | Never touch the network. Pure offline read of the replica. |
| `'remote-only'` | Always replicate, but don't keep a durable copy beyond the session (rare; escape hatch). |

The "if local is empty, fetch remote then show" behavior from the original concept is simply `local-first` with an empty replica — the first hydration fills it, the live query renders it. No special-case emptiness logic.

**Refresh cadence** is a *replication interval*, not a cache TTL — and it reuses the same `pollMs` / staleness vocabulary as the global pull path on the roadmap, so there is one mental model for "how often" across scoped and global replication.

---

## 5. Mutations: local write + replicate out (never a naked POST)

`useMutation` writes to the local collection first — immediate, durable, reactive — and **then replicates the change outward**. The critical rule:

> The outbound network call goes through a **durable outbox**, not a fire-and-forget `fetch`.

Because this is local-first, the write is *already committed* before the network is touched. If the POST fails (offline, 5xx, tab closed), you cannot roll back — the user may have built more work on top. A naked `fetch` here reinvents retry / dedup / offline handling, badly. Instead:

1. Write local (reactive, offline-capable).
2. Enqueue the change into a durable outbox, **tagged with its target endpoint**.
3. A background drainer flushes the outbox to the right endpoint, **reusing the existing push retry/backoff** already implemented in the Rust core (`packages/core/src/http_sync.rs`, `fire_with_retry`) rather than rebuilding it.

This is the established **write-behind** pattern — and it names precisely why the outbox is mandatory, not optional.

The endpoint tag on each outbox entry resolves the apparent tension between "per-page scoped endpoints" and "one durable queue": a single background drainer routes each queued change to its collection/endpoint. You get scoped endpoints **and** a centralized, reliable queue.

---

## 6. Multiple collections (`useQueries`)

`useQueries` runs N scoped replications in parallel, each hydrating its own collection, each reactive via its own live query — the answer for a page that needs several slices at once.

TalaDB is a document store: there are **no cross-collection server joins**, so a multi-slice page composes in the component (or via denormalized documents). The endpoint shape is a decision (see §8): default to **one endpoint per collection** (composes cleanly with `useQueries`, matches how REST devs think), with an optional "bundle" adapter that fans a single response out into several collections.

---

## 7. Where the boundary sits (explicit non-goals)

Keep `useQuery` as **declarative read-hydration over plain REST endpoints**. The moment you need incremental cursors, delete propagation, or true conflict merge, that is **not** `useQuery`'s job — that is the existing `SyncAdapter` / `db.sync()` path.

- `useQuery` **hydrates** a slice.
- `SyncAdapter` / `db.sync()` **incrementally syncs** a collection (cursors, tombstones, LWW).
- `useMutation` **bridges** a local write into the outbox.

Do not let `useQuery` grow into a second incremental-sync engine. Two half-overlapping sync systems is the failure mode to avoid.

---

## 8. Decisions

1. **Transport — Fork A vs Fork B.** ✅ *(Decided: sync-contract / Fork B)* — build on the existing `db.sync()` / `HttpSyncAdapter` machinery; it is the default and the only mode for writes. Raw REST (Fork A) is deferred to a later read-only adapter for origin-authoritative reference data. Near-term note from the current core: `runSync` scopes by **collection only** and replays from zero (cursors stubbed), so v0.9.1 scoped replication pulls the collection via `db.sync({ collections: [name] })` and filters locally in `useFind`; server-side filter-scoping and live incremental cursors are follow-ups on the sync contract, not blockers for this feature.
   - **Fork A (raw REST):** `useQuery({ collection, endpoint })` does a plain `GET`; the adapter upserts the JSON into the collection. `useMutation` does a plain `POST`. Works with **any existing API**, zero server changes. No incremental cursor, no server-driven deletes — a whole-slice overwrite. Two durability hazards: deletes don't propagate (a GET returns survivors; upsert never removes a server-deleted row, and diffing-to-delete risks nuking rows merely absent from a filtered/partial response), and concurrent offline writes clobber with no way for the server to detect the conflict.
   - **Fork B (sync contract):** the scoped fetch speaks the existing two-endpoint sync contract (`/push`, `/pull?since=`) scoped by collection + filter — inheriting incremental cursors, tombstones, and LWW merge, plus a single server-derived `authorize(req) → scope` seam. Requires the server to speak the contract and support server-side filtering on pull.
   - Recommendation *(pending your confirmation)*: **sync-contract (Fork B) as the default, and the only mode for writes** — it's the secure + durable choice (server-derived scope; tombstones + `since` cursors + LWW for correct deletes and conflict convergence; TalaDB already owns the machinery). Keep **raw REST (Fork A) as a read-only opt-in** for origin-authoritative reference data, with explicit full-replace semantics to contain the delete-propagation hazard.

2. **Write-authority per collection.** ✅ *(Decided)* — **Origin-authoritative by default; local-authoritative is an explicit, per-collection opt-in.** The origin is the final arbiter of a collection's truth unless that collection is *declared* local-authoritative. Rationale (secure + durable): origin-authoritative is fail-safe — the server validates and can reject a client write, so an untrusted client can't overwrite shared state, and multi-user data converges under server arbitration; if a dev doesn't think about it, the safe thing happens. Local-authoritative is reserved for genuinely single-owner, offline-first data (e.g. a user's private notes), where the user's offline edit must win over a stale server copy. Authority is **declared per collection, never inferred** — the wrong choice is a security bug on shared data or a vanished-edit bug on private data. This is the *write-authority* axis, orthogonal to the `source` *read* axis (§4); and regardless of authority, the outbox (§5) still guarantees *delivery* — authority only decides the final *value*. When a collection is local-authoritative it **still rides the sync-contract transport, never raw REST** — those writes need the outbox + conflict metadata most.

3. **Hook naming.** Keep `useQuery` / `useMutation` (adoption, familiarity) while documenting the replica-not-cache semantics? Or signal the difference with names like `useReplica` / `usePush`? Recommendation: keep the familiar names.

4. **In-flight dedup.** Two components mounting the same scoped query must not fire two identical GETs — dedup by a scope key `(endpoint + collection + filter)`. Straightforward, but specify it.

5. **SSR.** The DB is client-only (`'use client'`); there is no server-side replica to hydrate. First paint uses the existing `<TalaDBProvider fallback>`. Note the divergence from react-query SSR expectations in the docs.

---

## 9. Sketch of the surface (illustrative, not final)

```ts
// Read: hydrate a slice of an origin into a real local collection, reactively.
const { data, loading, error } = useQuery<Product>({
  collection: 'products',
  filter: { category: 'x' },
  endpoint: '/api/products',        // Fork A: plain GET
  source: 'local-first',            // read mode (§4)
  pollMs: 30_000,                   // replication interval (§4), optional
})

// Several slices at once (§6).
const [products, orders] = useQueries([
  { collection: 'products', endpoint: '/api/products' },
  { collection: 'orders',   endpoint: '/api/orders', filter: { since: startOfMonth } },
])

// Write: local-first write + replicate out via the durable outbox (§5).
const { mutate, pending } = useMutation<Order>({
  collection: 'orders',
  endpoint: '/api/orders',          // outbox target; POST is queued, not awaited inline
})
mutate({ _id, status: 'shipped' })  // local write is immediate + reactive
```

No `queryKey`. No `invalidateQueries`. A write to `orders` re-renders every hook watching `orders` (§3).

---

## 10. Inherited settings, encryption, authorization & typing

### Global `openDB` settings are inherited automatically

Because the hooks write through the **normal collection API** into the same local engine, every database-level guarantee applies to replicated data with **no per-hook configuration**:

- **Encryption at rest** — the replica lives in the same encrypted store as every other collection. Data hydrated from a remote endpoint is encrypted on disk exactly like locally-authored data. (A strength over a react-query cache, which sits unencrypted in memory / IndexedDB.)
- **Schema validation & migrations** — an upsert from a remote slice is validated against the collection's schema like any other write; migrations apply on open.
- **Durability / flush settings**, reserved `_`-prefixed collections, and live-query semantics — all inherited unchanged.

Two things to design for:

- **At rest ≠ in transit.** The DB key protects the on-disk replica; it does **not** encrypt the network hop. The wire is a separate concern — HTTPS/TLS on your API plus the auth header below. Document both so nobody assumes the DB key covers the wire.
- **Schema mismatch on hydrate.** If a remote document fails the local schema, the upsert fails. Pick a policy explicitly: reject the whole slice (strict) or skip-and-surface the offending docs (lenient). Recommend **lenient-with-a-surfaced-error**, so one bad server record doesn't blank a page.

### Authorization — a provider-level async resolver, resolved at send time

The existing adapters set headers once as a static map (`HttpSyncAdapterOptions.headers` / the Rust `SyncConfig` headers). Per-component scoped endpoints break that: different routes hit different endpoints, and tokens expire and refresh. Design:

- **Async resolver, not a baked string; provider-level default, per-hook override.** Set auth once on the replication provider as `getAuth: async () => ({ Authorization: \`Bearer ${await session.token()}\` })`, and let any hook override for a specific endpoint. Mirrors Apollo's auth-link / react-query's queryFn closure and the centralized style of `@taladb/next`'s `SyncProvider`.
- **Resolve at send time, never at enqueue time.** Critical for the write-behind outbox (§5): an offline edit may flush hours later, after the token has refreshed. Outbox entries therefore store **payload + endpoint only** — the drainer resolves the header fresh when it actually sends. Baking the header into the queued entry replays a stale/expired token.
- **The token is also the scope.** A browser/mobile client must never hold a real database credential (the roadmap states this for the native adapters). The endpoint is *your* API: it authorizes the session token and returns only that user's slice — so the auth header doubles as the per-user partition key for the pull (the `authorize(req) → scope` pattern already in `@taladb/next/server`). Auth is access control **and** the scoping mechanism.

### Strict types, end to end

The whole surface is generic over the document type — same discipline as `useFind<T>` today — with one hard rule at the network boundary:

- **Generics throughout.** `useQuery<T>` returns `T[]`; `filter` is `Filter<T>`; `useMutation<T>` accepts a payload typed to `T` (or a typed partial for updates). No `any` leaks into caller code.
- **No `as T` at the fetch boundary — this is the teeth of "strict types."** A remote response is `unknown` until it is **validated against the collection's schema**, then narrowed to `T`. The compile-time generic and the runtime schema check are the *same* boundary: a cast there is precisely the bug that lets malformed server data into a typed collection. Parse, don't assert.
- This means the schema-mismatch policy above isn't optional polish — it's the mechanism that makes the types *sound* rather than merely *declared*.

---

## 11. Summary

- It's a **replica, not a cache** — durable, first-class, never evicted (§1).
- It's **scoped, declarative replication** — the same concept as `db.sync()`, made per-component and on-demand; a surface *onto* sync, not a rival to it (§2, §7).
- **One-way data flow**: network writes to local, live queries re-render — which deletes the `queryKey`/`invalidateQueries` complexity entirely (§3).
- **Mutations go through a durable, endpoint-tagged outbox**, reusing existing push retry — never a naked POST (§5).
- **Inherits the DB's guarantees** — encryption at rest, schema validation, durability — because it writes through the normal engine; **auth is a provider-level async resolver resolved at send time**, so the offline outbox never replays a stale token (§10).
- **Strictly typed end to end** — generic over the document type, with remote JSON **validated against the schema, never cast** (`as T`) at the boundary (§10).
- **Decisions locked** — transport is sync-contract / Fork B (§8.1); write-authority is origin-authoritative by default with local-authoritative an explicit per-collection opt-in (§8.2).
