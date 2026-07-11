// The dummy origin the scoped-replication hooks pull from.
//
// This is a normal @taladb/next sync backend (POST /api/sync/push +
// GET /api/sync/pull) — the same contract useQuery/useQueries/useMutation ride.
// The only twist versus examples/nextjs-sync is that we pre-seed the store with
// a dummy catalog (products/categories/orders) so a fresh browser's very first
// `useQuery` pulls real rows instead of an empty set.
//
// seed.json is a real engine-exported changeset (see scripts/gen-seed.mjs) — the
// route just replays it into the store once, under a fixed demo scope. Not for
// production: state is in-process (dies on restart, not shared across instances)
// and every caller shares one scope. Swap memorySyncStore for taladbSyncStore /
// @taladb/sync-mongodb and a real `authorize` for anything multi-user.
import { createSyncHandlers, memorySyncStore } from '@taladb/next/server';
import seed from '../seed.json';

// One shared scope for the demo, so every browser pulls the same seeded catalog.
const DEMO_SCOPE = 'demo';

const store = memorySyncStore();

// Replay the dummy changeset into the scope once, before any request is served.
// LWW-keyed, so a hot-reload re-import is harmless.
const seeded = store.push(JSON.stringify(seed), DEMO_SCOPE);

const handlers = createSyncHandlers({
  store,
  authorize: () => DEMO_SCOPE,
});

export async function POST(req: Request): Promise<Response> {
  await seeded;
  return handlers.POST(req);
}

export async function GET(req: Request): Promise<Response> {
  await seeded;
  return handlers.GET(req);
}
