---
title: Scoped Replication — useQuery, useQueries, useMutation
description: React-query-shaped hooks for @taladb/react. Bind a component or route to a slice of a remote origin, backed by the local TalaDB replica — one-way data flow, local-first writes, and a durable outbox, built on the sync-contract transport.
---

# Scoped Replication Hooks

::: tip Upcoming in v0.9.1
`useQuery`, `useQueries`, and `useMutation` ship in `@taladb/react` **0.9.1**. The reactive base hooks (`useFind`, `useFindOne`, `useCollection`) are available today — see the [React guide](/guide/react).
:::

These hooks give you a react-query-shaped surface for binding a component to a **slice** of a remote origin, on demand — instead of the global, imperative [`db.sync()`](/guide/bidirectional-sync). Different routes replicate different slices at different times, declaratively.

The one idea that governs everything: **the local store is a replica, not a cache.** Unlike a react-query cache — disposable, evictable, server-owned — TalaDB's local data is durable, queryable, and offline-authoritative. A network fetch never becomes component state; it writes into the local collection, and your live query re-renders off that write. One-way data flow, so there is **no `queryKey` and no `invalidateQueries`** — writing to the collection *is* the invalidation.

## Setup

Wrap your tree in a `<ReplicationProvider>` inside the [`<TalaDBProvider>`](/guide/react#setup). It supplies the sync endpoint, an auth resolver, and a default poll interval:

```tsx
import { TalaDBProvider } from '@taladb/react'
import { ReplicationProvider } from '@taladb/react'

root.render(
  <TalaDBProvider name="myapp.db" fallback={<Splash />}>
    <ReplicationProvider
      endpoint="/api/sync"
      getAuth={async () => ({ Authorization: `Bearer ${await session.token()}` })}
      pollMs={30_000}
    >
      <App />
    </ReplicationProvider>
  </TalaDBProvider>
)
```

`endpoint` is *your* API — never a database credential. It authorizes the session token from `getAuth` and returns only that user's slice, so the auth header doubles as the per-user scope. It speaks the same two-endpoint [sync contract](/guide/bidirectional-sync#your-server-two-endpoints) as `db.sync()` (`POST /push`, `GET /pull`).

## Warming the replica on first run — `prefetch`

For a first-time user, a collection is empty until something pulls it. `prefetch` warms slices in the **background** so a later `useQuery` reads local instead of waiting on the network — the products list is already there when the user navigates to it.

```tsx
<ReplicationProvider
  endpoint="/api/sync"
  prefetch={['products', 'categories']}
>
```

Each entry is a collection name (or `{ collection, endpoint }`). Prefetch is deliberately unobtrusive:

- **Off the critical path** — it's deferred to browser idle (`requestIdleCallback`), starts after mount, and on web the pull runs in the sync Worker. First paint and interaction are never blocked.
- **First-run only** by default (`prefetchMode: 'once'`) — a slice is skipped once it has synced, so returning users don't re-warm. Set `prefetchMode: 'always'` to refresh on every mount.
- **Best-effort** — failures are silent; a `useQuery` will pull when the user actually navigates.
- **Coalesced** — if the user opens a page whose collection is still prefetching, that page's `useQuery` **joins the in-flight pull** rather than firing a second one.
- **Bounded** — at most `prefetchConcurrency` pulls run at once (default `2`), so warming many collections can't starve the page the user actually opened.

Think of it as the first-run complement to `pollMs`: `prefetch` warms, `pollMs` keeps warm, `useQuery` reads.

## Reading — `useQuery`

`useQuery` is a live query over the local replica plus a scoped pull. The pull writes into the collection; the live query re-renders on its own.

```tsx
import { useQuery } from '@taladb/react'

function ProductList() {
  const { data, loading, syncing } = useQuery<Product>({
    collection: 'products',
    filter: { category: 'kitchen' },
  })

  if (loading) return <Spinner />
  return (
    <>
      {syncing && <RefreshingBadge />}
      <ul>{data.map((p) => <li key={p._id}>{p.name}</li>)}</ul>
    </>
  )
}
```

The result:

| Field | Meaning |
|---|---|
| `data` | Matching documents from the local replica. Reactive. |
| `loading` | First local snapshot pending (plus the first pull, for `remote-first`). |
| `error` | Most recent local-read error. |
| `syncing` | A background replication pass is in flight. |
| `syncError` | Most recent replication error — the local data is still served. |
| `refetch()` | Trigger a pull now. |

### Read modes

The `source` option controls how the local replica and the remote origin combine:

| `source` | Behavior |
|---|---|
| `local-first` *(default)* | Serve local immediately; refresh in the background and re-render when the pull lands. |
| `remote-first` | Stay `loading` until the first pull completes, then serve. Use when staleness is unacceptable. |
| `local-only` | Never touch the network. Pure offline read — no endpoint required. |

```tsx
// A catalog you always want fresh before showing:
useQuery<Product>({ collection: 'products', source: 'remote-first' })

// Read purely offline data — works with no <ReplicationProvider>:
useQuery<Draft>({ collection: 'drafts', source: 'local-only' })
```

### Refresh interval

`pollMs` is a **replication interval**, not a cache TTL — the local data is never evicted, only refreshed. It overrides the provider default per query; omit or set `0` to disable polling.

```tsx
useQuery<Order>({ collection: 'orders', pollMs: 10_000 })
```

## Reading several slices — `useQueries`

For a page that needs multiple slices at once, run them in parallel. The result array is index-aligned with the input:

```tsx
import { useQueries } from '@taladb/react'

const [orders, products] = useQueries([
  { collection: 'orders', filter: { open: true } },
  { collection: 'products' },
])
```

TalaDB is a document store — there are no cross-collection joins — so compose the slices in your component. Each entry is an independent `useQuery` with its own collection, filter, source, and (optionally) endpoint.

## Writing — `useMutation`

A mutation writes the local replica **first** — immediate, durable, reactive (every `useQuery`/`useFind` on that collection re-renders) — and then replicates the change outward over the sync-contract with bounded retry. The network step never rolls the local write back: it is already committed, and a later drain still delivers it. This is the classic **write-behind** pattern; the durable outbox is what makes offline writes safe.

```tsx
import { useMutation } from '@taladb/react'

function ShipButton({ orderId }: { orderId: string }) {
  const { mutate, pending } = useMutation<Order>({ collection: 'orders' })

  return (
    <button
      disabled={pending}
      onClick={() => mutate({ type: 'update', where: { _id: orderId }, set: { status: 'shipped' } })}
    >
      {pending ? 'Shipping…' : 'Mark shipped'}
    </button>
  )
}
```

Write operations are a discriminated union:

```ts
mutate({ type: 'insert', doc: { item: 'Widget', qty: 3 } })
mutate({ type: 'update', where: { _id }, set: { status: 'shipped' } })
mutate({ type: 'delete', where: { _id } })
```

Use `mutateAsync` when you need to await the write (it resolves once the local write and drain settle, and rejects on error); `mutate` is fire-and-forget and surfaces failures on `error`.

### Write-authority

Writes are **origin-authoritative** by default: the push sends your change and the server is the final arbiter; read hooks pull the authoritative value on their next pass. This is the safe default for shared, multi-user data. (Collections that are genuinely single-owner and offline-first can opt into local-authoritative behavior — a follow-up.)

## Authorization

Set auth once on the provider as an **async resolver**, overridable per hook. It is resolved at **send time** — once per pass — so an offline write flushed hours later carries a current token, not the one that was live when the user made the edit:

```tsx
<ReplicationProvider
  endpoint="/api/sync"
  getAuth={async () => ({ Authorization: `Bearer ${await session.token()}` })}
>
```

## What it inherits

Because the hooks write through the normal collection API, replicated data gets every database-level guarantee automatically — **encryption at rest**, **schema validation**, migrations, durability. Data hydrated from a remote endpoint is encrypted on disk exactly like locally-authored data. (Encryption *at rest* is separate from *in transit* — the wire is HTTPS plus the auth header above.)

Types are strict end to end: `useQuery<T>` returns `T[]`, filters are `Filter<T>`, and a remote response is validated against the collection schema rather than cast.

## Relationship to `db.sync()`

This is not a second sync system — it's an ergonomic, per-component surface *onto* the same [sync-contract transport](/guide/bidirectional-sync). Rule of thumb:

- **`useQuery` / `useMutation`** — declarative, per-component slices.
- **[`db.sync()`](/guide/bidirectional-sync)** — imperative, whole-database or per-collection passes (background jobs, one-shot reconciliation).

They share the same endpoints, cursors, and Last-Write-Wins merge, so you can mix them freely.

## Current limitations (v0.9.1)

- **Runtime**: sync is wired for **Node.js** today; the browser (WASM) and React Native bindings are in progress (same as [bidirectional sync](/roadmap#sync)). The hooks ride those bindings as they land.
- **Scoping**: a query replicates its **whole collection** and filters locally. Server-side filter-scoping is a sync-contract follow-up.
- **`useQueries` typing**: entries are typed as `Document` for now; use `useQuery<T>` for a strictly-typed single slice. Per-entry generics are a follow-up.
- **`source: 'remote-only'`** is planned; the durable-replica model makes it a rare escape hatch.
