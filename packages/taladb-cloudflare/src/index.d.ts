import type { Collection, CollectionOptions, Document, Filter, TalaDB } from 'taladb';

/**
 * Thrown when a document fails schema validation on `insert` or `insertMany`.
 * Mirrors `TalaDbValidationError` from the `taladb` package.
 */
export declare class TalaDbValidationError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown, context?: string);
}

// ---------------------------------------------------------------------------
// CloudflareDB — TalaDB-compatible handle for Cloudflare Workers
// ---------------------------------------------------------------------------

export interface CloudflareDB extends Omit<TalaDB, 'compact' | 'close'> {
  collection<T extends Document = Document>(name: string, options?: CollectionOptions<T>): Collection<T>;
  /** Persist the current snapshot to Durable Objects storage. */
  flush(): Promise<void>;
  /** Compact the in-memory redb instance (no-op on in-memory backend). */
  compact(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// openDurableDB
// ---------------------------------------------------------------------------

/**
 * Open a TalaDB database backed by Durable Objects storage.
 *
 * Call once per request (or cache on the DO instance via `getDB()`).
 * After mutations call `db.flush()` to persist the snapshot.
 *
 * @param storage  `this.ctx.storage` from the Durable Object constructor.
 *
 * @example
 * ```ts
 * const db = await openDurableDB(this.ctx.storage);
 * const users = db.collection<User>('users');
 * await users.insert({ name: 'Alice' });
 * await db.flush();
 * ```
 */
export function openDurableDB(storage: DurableObjectStorage): Promise<CloudflareDB>;

// ---------------------------------------------------------------------------
// TalaDBDurableObject — base class
// ---------------------------------------------------------------------------

/**
 * Base Durable Object class that manages a TalaDB database.
 *
 * Extend and export this from your Worker entrypoint, then bind it in
 * `wrangler.toml` as a Durable Object binding.
 *
 * @example
 * ```ts
 * import { TalaDBDurableObject } from '@taladb/cloudflare';
 *
 * export class MyDB extends TalaDBDurableObject {
 *   async fetch(request: Request): Promise<Response> {
 *     const db = await this.getDB();
 *     const users = db.collection<{ name: string }>('users');
 *
 *     if (request.method === 'POST') {
 *       const body = await request.json<{ name: string }>();
 *       const id = await users.insert(body);
 *       await db.flush();
 *       return Response.json({ id });
 *     }
 *
 *     return Response.json(await users.find());
 *   }
 * }
 * ```
 */
export class TalaDBDurableObject {
  protected ctx: DurableObjectState;
  constructor(ctx: DurableObjectState, env: unknown);
  /** Get (or lazily open) the TalaDB database for this DO instance. */
  getDB(): Promise<CloudflareDB>;
  fetch(request: Request): Promise<Response>;
}
