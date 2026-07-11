# TalaDB — scoped replication hooks (Next.js)

Exercises the `@taladb/react` scoped-replication hooks added in **0.9.1** —
`useQuery`, `useQueries`, `useMutation`, and `prefetch` — against a **seeded
dummy origin**. Each hook binds a component to a slice of the origin on demand
and reads through the durable local replica (not a cache): a pull writes into the
real local collection and the live query re-renders off it.

Sibling example [`../nextjs-sync`](../nextjs-sync) shows the lower-level,
global-and-imperative `<SyncProvider>` + `db.sync()` path instead.

## Run

```bash
pnpm install          # from the repo root
pnpm --filter example-nextjs-replication dev
# open http://localhost:3000
```

## What each section shows

- **`useQuery` — products** — one slice, live-filtered locally by category,
  background-refreshed on the provider's `pollMs`. `refetch` forces a pull; the
  `syncing` flag reflects a pass in flight while local data keeps serving.
- **`useQueries` — dashboard** — `orders` and `categories` pulled in parallel,
  the result array index-aligned with the input.
- **`useMutation` — orders** — a local-first write: the list re-renders the
  instant the local write lands, then the change replicates out (write-behind,
  bounded retry — the local write is never rolled back).
- **`prefetch`** — `<ReplicationProvider prefetch={['products','categories']}>`
  warms those slices into the replica in the background on first load, so their
  pages read local immediately. Reload with the Network tab open to see the
  `/api/sync/pull` calls fire before you interact.

## How the dummy origin works

The hooks speak TalaDB's sync push/pull contract, not raw REST — so a change
record is the engine's own export format (a ULID id + a typed `op.Upsert`), not
hand-written JSON. [`scripts/gen-seed.mjs`](scripts/gen-seed.mjs) therefore lets
a real TalaDB produce it: it inserts the dummy catalog, calls `exportChanges`,
and writes [`app/api/sync/seed.json`](app/api/sync/seed.json). The route
([`app/api/sync/[[...action]]/route.ts`](app/api/sync/%5B%5B...action%5D%5D/route.ts))
replays that changeset into a `memorySyncStore` under one shared demo scope, then
serves the standard `createSyncHandlers` push/pull endpoints.

Regenerate the seed (e.g. after changing the dummy data) with:

```bash
pnpm --filter example-nextjs-replication seed
```

## Not for production

- `memorySyncStore` is in-process — state dies on restart and isn't shared
  across serverless instances. Swap in `taladbSyncStore(await openDB(…))` (Node
  runtime) or `@taladb/sync-mongodb`.
- `authorize` maps every caller to one shared scope so the demo needs no login.
  Return a real per-user scope (e.g. a verified session id) to partition data.
