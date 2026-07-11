// Your complete sync backend: POST /api/sync/push + GET /api/sync/pull.
//
// memorySyncStore keeps everything in process memory — perfect for trying the
// loop locally, wrong for production (state dies with the process and isn't
// shared across serverless instances). Swap in taladbSyncStore(await openDB(…))
// on a Node runtime, or @taladb/sync-mongodb, for something real.
import { createSyncHandlers, memorySyncStore } from '@taladb/next/server';

export const { POST, GET } = createSyncHandlers({
  store: memorySyncStore(),
  // Demo auth: any bearer token is accepted and becomes the caller's scope, so
  // two browser profiles with different tokens sync independent data sets.
  // Replace with your real session verification.
  authorize: (req) => {
    const auth = req.headers.get('authorization');
    return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  },
});
