import { TalaDB } from 'taladb';

/** The fields of a TalaDB change record the store keys on. Everything else in
 * a record is opaque — store it verbatim. */
interface ChangeRecord {
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
interface SyncStore {
    /** Merge a pushed changeset (JSON string of `ChangeRecord[]`) into `scope`. */
    push(changeset: string, scope: string): Promise<void>;
    /** Serialized changeset of `scope` changes with `changed_at > sinceMs`. */
    pull(sinceMs: number, scope: string): Promise<string>;
}
interface CreateSyncHandlersOptions {
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
interface SyncHandlers {
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
declare function createSyncHandlers(options: CreateSyncHandlersOptions): SyncHandlers;
/**
 * In-memory store — perfect for development and tests; state is lost on
 * server restart and not shared across serverless instances. Use
 * {@link taladbSyncStore} (or your own database) in production.
 */
declare function memorySyncStore(): SyncStore;
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
declare function taladbSyncStore(db: TalaDB, collectionName?: string): SyncStore;

export { type ChangeRecord, type CreateSyncHandlersOptions, type SyncHandlers, type SyncStore, createSyncHandlers, memorySyncStore, taladbSyncStore };
