# Replicating from a REST API

Point TalaDB at an API you already have, and your queries stop hitting the network.

```tsx
<ReplicationProvider replicate={{
  products: {
    endpoint: '/api/products',
    scope: `store:${storeId}`,
    revision: 'rev',
    pagination: 'offset',
    delta: true,
    mapRow: (r) => ({ sku: r.id, name: r.name, price: r.price, category: r.category }),
  },
}}>
```

```tsx
const { data, coverage } = useQuery<Product>({
  collection: 'products',
  filter: { category: 'kitchen', price: { $lt: 500 } },
  sort: { price: 1 },
  page: 2,
  limit: 100,
})
```

Once `products` is **covered** — fully replicated for this scope — that query runs
entirely on-device. Page 1, page 2, a new filter, a new sort, page 47, back to
page 1: **zero network requests**, instant, and it works offline.

---

## Why not just cache the pages?

The tempting design is to cache each `GET /api/products?page=2` response and reuse
it. Don't. It's a trap, and it's worth understanding why before you build on this.

If you only fetch the pages a user visits, your local database holds an **arbitrary
partial subset** of the catalog. Now the user filters by "under ₱500". Can you
answer from local? No — the matching products might be on page 43, which nobody has
visited. So you go to the network. They sort by price: network. They search: network.

A partial replica can only answer the queries you have *already asked*. You would
have shipped a Rust engine, a WASM worker and OPFS storage to buy a slightly more
persistent back-button than React Query already gives you for free.

**Coverage is the alternative.** Replicate the whole (bounded) collection once, in
the background. Now every query is local — including the ones nobody has asked yet.
That is the thing worth putting a database on the device for.

---

## What your API needs to provide

Three capabilities, in increasing order of how much they buy you.

| # | Capability | Endpoint | Without it |
|---|---|---|---|
| 1 | Paged list | `?page=&limit=` | Nothing works. Required. |
| 2 | Snapshot token | `snapshot` in the response | Coverage caps at **`best-effort`** — reads keep hitting the network |
| 3 | Delta feed | `?since=<cursor>` | No incremental refresh, and **deletions never propagate** |

Every row must also carry a monotonic numeric revision (default field `rev`, or
configure `revision`). TalaDB compares it inside the same write transaction, so a
slow stale bridge response cannot overwrite a newer delta response.

### 1. Paged list (required)

```
GET /api/products?page=0&limit=500
→ { "data": [ {"id":"sku-1","rev":9812,...}, ... ], "nextPage": 500, "total": 100000 }
```

A bare array works too, as do `{ items }` and `{ rows }` envelopes. Anything else,
pass `parse` to extract the rows yourself — TalaDB **throws rather than guesses**,
because a wrong guess yields an empty replica that reports itself complete.

### 2. Snapshot token — the one people skip, and shouldn't

Walking `?page=1,2,3…` over live data is **not a consistent read**, and it fails
silently:

1. The client fetches page 1 (rows 0–99).
2. Someone deletes a product. Every later row shifts up by one.
3. The client fetches page 2 at offset 100 — but the row that *was* at offset 100
   is now at 99, **which it already passed**.
4. That row is never fetched. The walk completes. Coverage flips to `complete`.

From then on, every query is answered locally from a replica with a hole in it. No
error. No warning. A product that simply doesn't exist for that user until the next
full rebuild.

A snapshot token pins the whole walk to one logical view of the table:

```
GET /api/products?limit=500
→ { "data": [...], "nextPage": 500,
    "snapshot": "rev-9812",      ← issue this on the first page
    "deltaCursor": "rev-9812" }

GET /api/products?page=500&limit=500&snapshot=rev-9812   ← client echoes it back
```

On Postgres this is a monotonic revision column and a `rev <= :snapshot` predicate.
No long-lived transaction, no repeatable-read isolation — just a `WHERE` clause.

**If you can't provide one, TalaDB will not lie about it.** Coverage caps at
`best-effort`, `useQuery` keeps serving from the network, and `useCoverage()`
reports why. The replica is still useful; it just isn't *trusted*.

> Issue `deltaCursor` on the **first** page, as of the snapshot — not after the walk
> ends. Anything that changes *during* the walk would otherwise fall between
> "bootstrap finished" and "delta started", and be lost forever.

### 3. Delta feed — the only way deletions ever propagate

```
GET /api/products?since=rev-9812
→ { "data":    [ {...changed rows...} ],
    "deleted": ["sku-9", "sku-12"],
    "cursor":  "rev-9950" }
```

A paged `GET` returns *survivors*. A row's **absence** from a response is ambiguous:
was it deleted, or did it merely shift to another page? TalaDB refuses to guess,
because guessing eventually deletes live data. So if your API doesn't report
deletions here, **deleted rows live on in every client forever**.

A soft-delete table, or an `is_deleted` flag alongside the revision, is the usual
answer. It's a small amount of work and it's the difference between a replica that
converges and one that slowly accumulates ghosts.

---

## Server helpers

```ts
// app/api/products/route.ts
import { createReplicationHandlers } from '@taladb/next/server'

export const { GET } = createReplicationHandlers({
  authorize: (req) => getSession(req)?.storeId ?? null,   // your security boundary

  async bootstrap({ page, limit, snapshot, scope }) {
    const rev = snapshot ?? String(await currentRevision())
    const offset = Number(page ?? 0)
    const rows = await sql`
      SELECT id, name, price, category, rev FROM products
      WHERE store_id = ${scope} AND rev <= ${rev} AND NOT is_deleted
      ORDER BY id LIMIT ${limit} OFFSET ${offset}`
    return {
      rows,
      nextPage: rows.length < limit ? null : offset + limit,
      snapshot: rev,
      deltaCursor: rev,
    }
  },

  async delta({ since, scope }) {
    const rows = await sql`
      SELECT id, name, price, category, rev, is_deleted FROM products
      WHERE store_id = ${scope} AND rev > ${since}`
    return {
      changed: rows.filter((r) => !r.is_deleted),
      deleted: rows.filter((r) => r.is_deleted).map((r) => r.id),
      cursor: String(await currentRevision()),
    }
  },
})
```

The handlers are framework-neutral (`Request` → `Response`), so they also drop into
Remix, Hono, or an Express adapter.

---

## Cold start

Before the walk finishes, the replica is incomplete. What the user sees depends on
your app:

| App | What paints first |
|---|---|
| **Next.js (SSR/RSC)** | Server-render from the origin. Hydration runs behind it; local takes over **once coverage completes** — which may be several navigations later, not necessarily the next one. |
| **Vite SPA** | No server render, so `useQuery` **bridges**: it fetches exactly the rows this query needs and paints immediately. |
| **React Native** | Same as SPA. |

**Bridged rows are not a cache.** They are written into the same collection, under
the same derived ids the background walk uses — so when the walk reaches them it
overwrites them in place rather than duplicating them. A bridge fetch is a *down
payment on the replica*, not a parallel copy of it that has to be reconciled later.

A bridge fetch **never advances coverage**. It didn't come from the snapshot and
proves nothing about completeness, so it can't be allowed to masquerade as a
hydrated catalog.

---

## Choosing what to replicate

Not everything should be. Be honest about it:

| Data | Strategy |
|---|---|
| Products, categories — bounded, shared, read-heavy | **Replicate.** This is the win. |
| Cart, wishlist, recently-viewed | Local-authoritative, sync out with `useMutation`. |
| Orders | User-scoped sync contract. |
| **Stock, price-at-checkout, payment** | **Never from a replica.** Validate server-side. |
| Reviews, feeds, anything unbounded | **Keep React Query.** TalaDB doesn't replace it, and shouldn't pretend to. |

### Replicate an index, not the whole document

A 100k-product catalog with full descriptions and image metadata is a big download.
A *projection* usually isn't:

```ts
products: {
  endpoint: '/api/products',
  // ~100 bytes/row → 100k products ≈ 10 MB in OPFS
  mapRow: (r) => ({ sku: r.id, name: r.name, price: r.price, category: r.category, thumb: r.thumb }),
}
```

Search, filter, sort and paging all run locally off that. Lazy-load the full product
detail on the product page — into a **separate collection**, never as extra fields on
the same document. Remote writes replace the whole document, so a slim delta would
otherwise erase the `description` and `images` you fetched later.

---

## Controlling when hydration runs

```ts
products: {
  endpoint: '/api/products',
  hydrate: 'idle',    // 'eager' | 'idle' (default) | 'manual'
  pageSize: 500,
  refreshMs: 60_000,
}
```

A 10 MB first-visit download is real on mobile. `'idle'` defers to
`requestIdleCallback`; `'manual'` hands the timing to you (e.g. start only when the
user enters the catalog route, and skip it entirely on a metered connection).

The walk **yields between pages**. This isn't cosmetic: live queries re-run on a
300 ms poll, and on React Native every write is *synchronous on the JS thread* — a
tight import loop freezes the app for its duration.

---

## Coverage, and why `best-effort` is not `complete`

```tsx
const { status, ready, progress, reason } = useCoverage('products')
if (!ready) return <ProgressBar value={progress} />
```

| `status` | Local reads authorized? | Meaning |
|---|---|---|
| `empty` | no | Nothing local yet. |
| `hydrating` | no | The walk is running. `progress` is 0–1. |
| **`complete`** | **yes** | Fully replicated, from a consistent snapshot. |
| `best-effort` | **no** | Every row the origin offered was applied — but it couldn't pin a snapshot, so a row that shifted mid-walk may have been missed. We can't *prove* the replica is whole. |
| `stale` | no | Was complete; something invalidated it. |
| `error` | no | The walk failed. `reason` says why; it resumes from its checkpoint. |

`best-effort` is the interesting one. It's tempting to treat it as good enough — it
usually is! — but "usually" is exactly the problem: the failure is silent and
data-dependent. Serving an incomplete replica as authoritative returns *wrong
results with no error*, which is strictly worse than going to the network.

---

## Multi-tenancy: always set `scope`

```ts
products: { endpoint: '/api/products', scope: `store:${storeId}` }
```

Coverage is keyed on `(origin, collection, scope, projectionVersion, schemaVersion)`.
Without `scope`, user B logging in **inherits user A's `complete` flag** — and reads
user A's rows from the local replica, believing them to be their own. Set it for
anything that isn't genuinely global.

Bumping `projectionVersion` or `schemaVersion` invalidates coverage too: a replica
hydrated with a slimmer projection is not complete for a query that needs the fields
you dropped.
