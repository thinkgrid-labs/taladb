// @taladb/next/server — sync backend for Next.js route handlers.
//
// Implements the two-endpoint contract that `HttpSyncAdapter` expects
// (POST {endpoint}/push · GET {endpoint}/pull?since=), using the standard Web
// Request/Response API — so the same handlers also work in any framework that
// speaks fetch handlers (Remix, SvelteKit, Hono, Bun, plain Node via an
// adapter). Nothing here imports `next` itself.

import type { TalaDB } from 'taladb';

// ---------------------------------------------------------------------------
// Change records & store contract
// ---------------------------------------------------------------------------

/** The fields of a TalaDB change record the store keys on. Everything else in
 * a record is opaque — store it verbatim. */
export interface ChangeRecord {
  collection: string;
  id: string;
  changed_at: number;
  [key: string]: unknown;
}

/**
 * Where pushed changes live. Implementations keep the **latest change per
 * document per scope** (Last-Write-Wins by `changed_at`) and answer
 * "everything in this scope newer than `sinceMs`".
 *
 * `scope` partitions users or workspaces — the value returned by
 * `authorize`. A store must never leak changes across scopes.
 */
export interface SyncStore {
  /** Merge a pushed changeset (JSON string of `ChangeRecord[]`) into `scope`. */
  push(changeset: string, scope: string): Promise<void>;
  /** Serialized changeset of `scope` changes with `changed_at > sinceMs`. */
  pull(sinceMs: number, scope: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export interface CreateSyncHandlersOptions {
  store: SyncStore;
  /**
   * Identify and authorize the caller, returning a scope key (e.g. the user
   * id) — this is your security boundary. Return `null`/`undefined` to reject
   * with 401. Omit for a single shared scope (`'default'`) — fine for
   * prototypes and single-user apps, wrong for anything multi-user.
   */
  authorize?: (req: Request) => Promise<string | null | undefined> | string | null | undefined;
}

export interface SyncHandlers {
  /** Mount as the handler for `POST {endpoint}/push`. */
  POST(req: Request): Promise<Response>;
  /** Mount as the handler for `GET {endpoint}/pull`. */
  GET(req: Request): Promise<Response>;
}

/**
 * A complete sync backend as a pair of fetch-style route handlers.
 *
 * ```ts
 * // app/api/sync/[[...action]]/route.ts
 * import { createSyncHandlers, memorySyncStore } from '@taladb/next/server'
 *
 * export const { POST, GET } = createSyncHandlers({
 *   store: memorySyncStore(),
 *   authorize: async (req) => verifySession(req.headers.get('authorization')),
 * })
 * ```
 *
 * Point the client's `HttpSyncAdapter` at `endpoint: '/api/sync'`.
 */
export function createSyncHandlers(options: CreateSyncHandlersOptions): SyncHandlers {
  const { store } = options;
  const authorize = options.authorize ?? (() => 'default');

  async function resolveScope(req: Request): Promise<string | null> {
    const scope = await authorize(req);
    return scope ?? null;
  }

  return {
    async POST(req: Request): Promise<Response> {
      const scope = await resolveScope(req);
      if (scope === null) return new Response('unauthorized', { status: 401 });

      const body = await req.text();
      // Validate shape before it reaches the store — reject non-array bodies
      // and records missing the keys every store depends on.
      let records: unknown;
      try {
        records = JSON.parse(body === '' ? '[]' : body);
      } catch {
        return new Response('invalid changeset: not JSON', { status: 400 });
      }
      if (!Array.isArray(records)) {
        return new Response('invalid changeset: expected a JSON array', { status: 400 });
      }
      for (const r of records) {
        const rec = r as Partial<ChangeRecord>;
        if (
          typeof rec !== 'object' || rec === null ||
          typeof rec.collection !== 'string' ||
          typeof rec.id !== 'string' ||
          typeof rec.changed_at !== 'number'
        ) {
          return new Response('invalid changeset: malformed change record', { status: 400 });
        }
      }
      if (records.length > 0) {
        await store.push(JSON.stringify(records), scope);
      }
      return new Response(null, { status: 204 });
    },

    async GET(req: Request): Promise<Response> {
      const scope = await resolveScope(req);
      if (scope === null) return new Response('unauthorized', { status: 401 });

      const sinceRaw = new URL(req.url).searchParams.get('since') ?? '0';
      const since = Number(sinceRaw);
      if (!Number.isFinite(since) || since < 0) {
        return new Response('invalid since parameter', { status: 400 });
      }
      const changeset = await store.pull(since, scope);
      return new Response(changeset, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in stores
// ---------------------------------------------------------------------------

/**
 * In-memory store — perfect for development and tests; state is lost on
 * server restart and not shared across serverless instances. Use
 * {@link taladbSyncStore} (or your own database) in production.
 */
export function memorySyncStore(): SyncStore {
  // scope → (collection::id → latest record)
  const scopes = new Map<string, Map<string, ChangeRecord>>();
  return {
    async push(changeset, scope) {
      let docs = scopes.get(scope);
      if (!docs) {
        docs = new Map();
        scopes.set(scope, docs);
      }
      for (const change of JSON.parse(changeset) as ChangeRecord[]) {
        const key = `${change.collection}::${change.id}`;
        const existing = docs.get(key);
        if (!existing || change.changed_at > existing.changed_at) docs.set(key, change);
      }
    },
    async pull(sinceMs, scope) {
      const docs = scopes.get(scope);
      if (!docs) return '[]';
      return JSON.stringify([...docs.values()].filter((c) => c.changed_at > sinceMs));
    },
  };
}

/**
 * A store backed by a server-side TalaDB — TalaDB syncing to TalaDB. Open a
 * file-backed database once (Node.js runtime, not edge) and hand it in:
 *
 * ```ts
 * import { openDB } from 'taladb'
 * import { createSyncHandlers, taladbSyncStore } from '@taladb/next/server'
 *
 * const serverDb = await openDB('sync-hub.db')
 * export const { POST, GET } = createSyncHandlers({ store: taladbSyncStore(serverDb) })
 * ```
 *
 * One document per synced client document per scope, holding the latest
 * change (LWW) — the same layout as `@taladb/sync-mongodb`, so any number of
 * clients converge through it.
 */
export function taladbSyncStore(db: TalaDB, collectionName = 'sync_changes'): SyncStore {
  interface Row {
    _id?: string;
    scope: string;
    key: string;
    changed_at: number;
    /** The full change record, serialized — opaque to the store. */
    change: string;
    [key: string]: string | number | undefined;
  }
  const col = db.collection<Row>(collectionName);
  // One-sided indexed ranges are fast (see /benchmarks); pull filters on
  // changed_at, push looks up by key.
  const indexed = (async () => {
    await col.createIndex('key').catch(() => {});
    await col.createIndex('changed_at').catch(() => {});
  })();

  return {
    async push(changeset, scope) {
      await indexed;
      for (const change of JSON.parse(changeset) as ChangeRecord[]) {
        const key = `${change.collection}::${change.id}`;
        const serialized = JSON.stringify(change);
        const existing = await col.findOne({ scope, key } as never);
        if (!existing) {
          await col.insert({ scope, key, changed_at: change.changed_at, change: serialized });
        } else if (change.changed_at > existing.changed_at) {
          await col.updateOne(
            { scope, key } as never,
            { $set: { changed_at: change.changed_at, change: serialized } } as never,
          );
        }
      }
    },
    async pull(sinceMs, scope) {
      await indexed;
      const rows = await col.find({ scope, changed_at: { $gt: sinceMs } } as never);
      return `[${rows.map((r) => r.change).join(',')}]`;
    },
  };
}
