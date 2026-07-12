# Coverage-first storefront (Vite SPA)

A pure-React SPA — **no SSR** — replicating a 5,000-product catalog from an ordinary
paged REST API, then serving every query from the device.

```bash
pnpm install
pnpm --filter example-vite-spa-storefront api    # the mock origin, port 8787
pnpm --filter example-vite-spa-storefront dev    # the app, port 5173
```

## What to watch

**The request counter in the top right.** It reads the *origin's own* count, so it's
proof rather than a claim.

1. **Cold start.** The replica is empty and there's no server render to paint behind,
   so `useQuery` **bridges**: it fetches exactly the rows the current page needs and
   renders immediately. The counter ticks.
2. **Hydration.** In the background, the coordinator walks the catalog 500 rows at a
   time, yielding between pages so the UI stays responsive. The counter climbs to
   ~11 and the header shows progress.
3. **Coverage.** The header flips to *"5,000 products replicated locally"*.
4. **Now interact.** Page forward. Page back to 1. Change the category. Flip the sort.
   Jump to page 30.

   **The counter does not move.** Not once.

Then open DevTools → Network → **Offline**, and keep browsing. Everything still works.

## Why this is not a page cache

A cache of API responses could serve page 1 again from memory. It could **not** serve
you a category you'd never opened, or a sort you'd never applied — those rows might
be on page 43, which was never fetched.

A *covered replica* answers queries nobody has asked yet. That's the difference, and
it's the reason to put a real database on the device rather than a `Map` of responses.

## Why the bridge isn't wasted work

The rows the bridge fetches on cold start are written into the same collection, under
the same **derived ids** (`deriveDocId(collection, remoteKey)`) that the background
walk will use. So when the walk reaches them, it overwrites them in place rather than
duplicating them.

A bridge fetch is a *down payment on the replica*, not a parallel copy that has to be
reconciled later. Nothing has to be thrown away.

## What the mock origin does (and why)

`server/api.mjs` is deliberately an ordinary REST API. It implements the three things
from [the guide](../../docs/guide/rest-replication.md):

- `?page=&limit=` — paged list.
- `snapshot` — a **consistency token**. Every row carries a monotonic `rev`, and each
  page reads `rev <= snapshot`. Without this, a row deleted mid-walk shifts every
  later row up by one, and the row now sitting at an offset the walk already passed
  is **never fetched** — the walk still "succeeds", and the replica silently has a
  hole in it. On Postgres this is a `WHERE rev <= $1` clause, not a long-lived
  transaction.
- `?since=<cursor>` — a delta feed, reporting both changed rows **and deleted ids**.
  A paged GET only returns survivors, and absence is ambiguous (deleted, or shifted?),
  so the client refuses to guess. Without this, deleted rows would live on in every
  client forever.

The origin reprices a random product every 5 seconds. With `refreshMs: 15_000`, watch
a price change on screen without a reload — the delta feed lands, the write hits the
local collection, and the live query re-renders. That's the same one-way data flow as
every other TalaDB write.

## Try breaking it

Delete `snapshot` from the bootstrap response in `server/api.mjs`. The app still
works — but coverage now reports **`best-effort`**, and `useQuery` keeps serving from
the network instead of the replica. That's deliberate: without a snapshot we can't
*prove* the replica is whole, and serving an incomplete replica as authoritative
returns wrong answers with no error, which is worse than a network round-trip.
