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
  /** Maximum accepted push body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Maximum records accepted in one push. Default 10,000. */
  maxRecords?: number;
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
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxRecords = options.maxRecords ?? 10_000;
  const authorize = options.authorize ?? (() => 'default');

  async function resolveScope(req: Request): Promise<string | null> {
    const scope = await authorize(req);
    return scope ?? null;
  }

  return {
    async POST(req: Request): Promise<Response> {
      const scope = await resolveScope(req);
      if (scope === null) return new Response('unauthorized', { status: 401 });

      const declaredLength = Number(req.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        return new Response('changeset too large', { status: 413 });
      }

      const body = await req.text();
      if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
        return new Response('changeset too large', { status: 413 });
      }
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
      if (records.length > maxRecords) {
        return new Response('too many change records', { status: 413 });
      }
      for (const r of records) {
        const rec = r as Partial<ChangeRecord>;
        if (
          typeof rec !== 'object' || rec === null ||
          typeof rec.collection !== 'string' ||
          typeof rec.id !== 'string' ||
          typeof rec.changed_at !== 'number' ||
          !Number.isSafeInteger(rec.changed_at) ||
          rec.changed_at < 0
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
      if (!Number.isSafeInteger(since) || since < 0) {
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
  // Preserve every distinct candidate at the greatest timestamp. TalaDB core
  // applies its exact postcard/delete tie-break when importing the candidates.
  const scopes = new Map<string, Map<string, ChangeRecord[]>>();
  return {
    async push(changeset, scope) {
      let docs = scopes.get(scope);
      if (!docs) {
        docs = new Map();
        scopes.set(scope, docs);
      }
      for (const change of JSON.parse(changeset) as ChangeRecord[]) {
        const key = `${change.collection}::${change.id}`;
        const existing = docs.get(key) ?? [];
        const latest = existing[0]?.changed_at;
        if (latest === undefined || change.changed_at > latest) docs.set(key, [change]);
        else if (change.changed_at === latest) {
          const serialized = JSON.stringify(change);
          if (!existing.some((candidate) => JSON.stringify(candidate) === serialized)) {
            existing.push(change);
          }
        }
      }
    },
    async pull(sinceMs, scope) {
      const docs = scopes.get(scope);
      if (!docs) return '[]';
      return JSON.stringify(
        [...docs.values()].flat().filter((c) => c.changed_at > sinceMs),
      );
    },
  };
}

const taladbStoreQueues = new WeakMap<object, Map<string, Promise<void>>>();

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
 * Stores the greatest timestamp per synced document and preserves distinct
 * equal-timestamp candidates so TalaDB core can apply its exact deterministic
 * tie-break when clients import them.
 */
export function taladbSyncStore(db: TalaDB, collectionName = 'sync_changes'): SyncStore {
  interface Row {
    _id?: string;
    scope: string;
    doc_key: string;
    changed_at: number;
    /** The full change record, serialized — opaque to the store. */
    change: string;
    [key: string]: string | number | undefined;
  }
  const col = db.collection<Row>(collectionName);
  // One-sided indexed ranges are fast (see /benchmarks); pull filters on
  // changed_at, push looks up by the scoped document key.
  const indexed = (async () => {
    await col.createIndex('doc_key').catch(() => {});
    await col.createIndex('changed_at').catch(() => {});
  })();

  let queues = taladbStoreQueues.get(db as object);
  if (!queues) {
    queues = new Map();
    taladbStoreQueues.set(db as object, queues);
  }

  return {
    async push(changeset, scope) {
      const run = async () => {
      await indexed;
      for (const change of JSON.parse(changeset) as ChangeRecord[]) {
        const docKey = `${change.collection}::${change.id}`;
        const serialized = JSON.stringify(change);
        const existing = await col.find({ scope, doc_key: docKey } as never);
        const latest = existing.reduce((n, row) => Math.max(n, row.changed_at), -Infinity);
        if (change.changed_at > latest) {
          if (existing.length > 0) await col.deleteMany({ scope, doc_key: docKey } as never);
          await col.insert({ scope, doc_key: docKey, changed_at: change.changed_at, change: serialized });
        } else if (
          change.changed_at === latest &&
          !existing.some((row) => row.change === serialized)
        ) {
          await col.insert({ scope, doc_key: docKey, changed_at: change.changed_at, change: serialized });
        }
      }
      };
      const previous = queues!.get(collectionName) ?? Promise.resolve();
      const operation = previous.then(run, run);
      queues!.set(collectionName, operation.catch(() => {}));
      await operation;
    },
    async pull(sinceMs, scope) {
      await indexed;
      const rows = await col.find({ scope, changed_at: { $gt: sinceMs } } as never);
      return `[${rows.map((r) => r.change).join(',')}]`;
    },
  };
}

// ---------------------------------------------------------------------------
// Coverage-first replication (REST origins)
//
// The sync-contract handlers above serve TalaDB peers. These serve *ordinary
// paged REST clients* — the path that lets a team point TalaDB at an API they
// already have. See ./replication.ts.
// ---------------------------------------------------------------------------
export {
  createReplicationHandlers,
  type BootstrapArgs,
  type BootstrapResult,
  type CreateReplicationHandlersOptions,
  type DeltaArgs,
  type DeltaResult,
  type ReplicationHandlers,
  type Row,
} from './replication';
