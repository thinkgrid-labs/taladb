# nextjs-sync — local-first Next.js app with TalaDB bidirectional sync

The smallest complete picture of the flagship TalaDB pattern:

- **On-device database** — reads and writes hit TalaDB in the browser (WASM + OPFS worker). The app works fully offline.
- **Background sync** — `<SyncProvider>` drives `db.sync()` every 10 s (plus on start, reconnect, and tab focus) against `/api/sync`, entirely off the main thread.
- **Your API is the backend** — `app/api/sync/[[...action]]/route.ts` is a complete sync server in one `createSyncHandlers()` call, with per-token scoping.

```bash
pnpm install
pnpm --filter taladb build --filter @taladb/react build --filter @taladb/next build
pnpm --filter example-nextjs-sync dev
```

Open http://localhost:3000 in two windows: notes converge within a sync pass. The demo store is in-memory (`memorySyncStore`) — restart the server and the *server-side* copy resets, while every browser keeps its local data and re-pushes on the next pass. Swap in `taladbSyncStore(await openDB('hub.db'))` or `@taladb/sync-mongodb` for a persistent hub.

Full guide: [taladb.dev/guide/bidirectional-sync](https://taladb.dev/guide/bidirectional-sync)
