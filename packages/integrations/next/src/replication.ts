/**
 * Server helpers for coverage-first replication.
 *
 * Implements the two endpoints a client needs to build a **trustworthy** local
 * replica of a table:
 *
 * - `GET  ?page=&limit=&snapshot=` — the bootstrap walk
 * - `GET  ?since=<cursor>`         — the delta feed
 *
 * Framework-neutral: it takes a `Request` and returns a `Response`, so it drops
 * into a Next route handler, a Remix loader, a Hono route, or an Express adapter.
 *
 * ## Why the snapshot matters more than it looks
 *
 * The obvious way to build a replica is to walk `?page=1,2,3…` and stop. It is
 * also **wrong on live data**, and wrong in a way nothing detects.
 *
 * Fetch page 1. A row gets deleted. Every later row shifts up one. Fetch page 2 at
 * offset 100 — but the row that *was* at offset 100 is now at 99, which you already
 * passed. It is never fetched. The walk completes, the client marks the collection
 * complete, and from then on every query is served locally from a replica with a
 * silent hole in it. No error, no warning, just a product that quietly doesn't
 * exist for that user until the next full rebuild.
 *
 * A snapshot token fixes it: the client echoes it back on every page, and the
 * server answers each page from the *same logical view* of the table. On Postgres
 * this is a monotonic revision column and a `rev <= :snapshot` predicate — no
 * long-lived transaction required.
 *
 * An origin that cannot do this is still usable, but the client caps its coverage
 * at `best-effort` and keeps serving reads from the network, because it cannot
 * prove the replica is whole. That is the honest outcome, and it is why
 * {@link createReplicationHandlers} pushes you toward supporting it.
 */

/** A row as your database returns it. Must carry a stable primary key. */
export type Row = Record<string, unknown>;

export interface BootstrapArgs {
  /** Offset (or opaque page token) to resume from. `null` on the first page. */
  page: string | number | null;
  /** Rows requested. Already clamped to `maxLimit`. */
  limit: number;
  /**
   * The snapshot to read from — `null` on the first page, when you should *issue*
   * one. Every later page echoes it back, and you must answer from that same view.
   */
  snapshot: string | null;
  /** The authorized scope (tenant, user, store). Never serve across scopes. */
  scope: string;
}

export interface BootstrapResult {
  rows: Row[];
  /** Resume token for the next page; `null` when the walk is done. */
  nextPage: string | number | null;
  /**
   * Issue this on the first page. Omitting it caps the client at `best-effort`
   * coverage — reads keep hitting the network forever. See the module doc.
   */
  snapshot?: string;
  /**
   * The cursor the delta feed should resume from — issued **on the first page**,
   * i.e. as of the snapshot. Issuing it after the walk instead would lose anything
   * that changed *during* the walk: it would fall between "bootstrap ended" and
   * "delta began".
   */
  deltaCursor?: string;
  /** Total rows in scope, if cheap to know. Drives the client's progress bar. */
  total?: number;
}

export interface DeltaArgs {
  /** The cursor the client last stored. */
  since: string;
  scope: string;
}

export interface DeltaResult {
  changed: Row[];
  /**
   * Primary keys deleted since `since`.
   *
   * **This is the only way a REST replica ever learns about a deletion.** A paged
   * GET returns survivors, and a row's absence is ambiguous — deleted, or merely
   * shifted to another page? The client refuses to guess (guessing eventually
   * deletes live data), so if you don't report deletions here, deleted rows live
   * on in every client forever. A soft-delete table or an `is_deleted` flag with a
   * revision is the usual answer.
   */
  deleted: Array<string | number>;
  cursor: string;
  hasMore?: boolean;
}

export interface CreateReplicationHandlersOptions {
  bootstrap(args: BootstrapArgs): Promise<BootstrapResult>;
  delta?(args: DeltaArgs): Promise<DeltaResult>;
  /**
   * Identify the caller and return a scope key — **your security boundary**.
   * Return `null` to reject with 401. Omit only for genuinely public data: without
   * it every caller shares one scope, and a replica hydrated by one user is served
   * to the next.
   */
  authorize?(req: Request): Promise<string | null | undefined> | string | null | undefined;
  /** Largest page a client may request. Default 1000. */
  maxLimit?: number;
  /** Page size when the client doesn't ask. Default 500. */
  defaultLimit?: number;
}

export interface ReplicationHandlers {
  /** Mount as the `GET` handler for your collection endpoint. */
  GET(req: Request): Promise<Response>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Build the `GET` handler that serves both the bootstrap walk and the delta feed.
 *
 * The two are distinguished by the query string: `?since=` means delta, anything
 * else means bootstrap.
 *
 * @example
 * // app/api/products/route.ts
 * export const { GET } = createReplicationHandlers({
 *   authorize: (req) => getSession(req)?.storeId ?? null,
 *   async bootstrap({ page, limit, snapshot, scope }) {
 *     // Issue a snapshot on the first page: the current max revision. Later pages
 *     // read `rev <= snapshot`, so the walk sees one consistent view of the table
 *     // even while it is being written to.
 *     const rev = snapshot ?? String(await currentRevision());
 *     const offset = Number(page ?? 0);
 *     const rows = await sql`
 *       SELECT id, name, price, category, rev FROM products
 *       WHERE store_id = ${scope} AND rev <= ${rev} AND NOT is_deleted
 *       ORDER BY id LIMIT ${limit} OFFSET ${offset}`;
 *     return {
 *       rows,
 *       nextPage: rows.length < limit ? null : offset + limit,
 *       snapshot: rev,
 *       deltaCursor: rev,
 *       total: await countProducts(scope, rev),
 *     };
 *   },
 *   async delta({ since, scope }) {
 *     const rows = await sql`
 *       SELECT id, name, price, category, rev, is_deleted FROM products
 *       WHERE store_id = ${scope} AND rev > ${since}`;
 *     const now = String(await currentRevision());
 *     return {
 *       changed: rows.filter((r) => !r.is_deleted),
 *       deleted: rows.filter((r) => r.is_deleted).map((r) => r.id),
 *       cursor: now,
 *     };
 *   },
 * });
 */
export function createReplicationHandlers(
  options: CreateReplicationHandlersOptions,
): ReplicationHandlers {
  const {
    bootstrap,
    delta,
    authorize,
    maxLimit = 1000,
    defaultLimit = 500,
  } = options;

  return {
    async GET(req: Request): Promise<Response> {
      let scope = 'default';
      if (authorize) {
        const result = await authorize(req);
        if (!result) return json({ error: 'unauthorized' }, 401);
        scope = result;
      }

      const url = new URL(req.url);
      const since = url.searchParams.get('since');

      if (since !== null) {
        if (!delta) {
          return json(
            {
              error:
                'this endpoint has no delta feed; the client cannot refresh ' +
                'incrementally and deletions will never propagate',
            },
            501,
          );
        }
        const result = await delta({ since, scope });
        return json({
          data: result.changed,
          deleted: result.deleted,
          cursor: result.cursor,
          hasMore: result.hasMore ?? false,
        });
      }

      const rawLimit = Number(url.searchParams.get('limit') ?? defaultLimit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), maxLimit)
          : defaultLimit;
      const pageParam = url.searchParams.get('page');
      const result = await bootstrap({
        page: pageParam === null ? null : pageParam,
        limit,
        snapshot: url.searchParams.get('snapshot'),
        scope,
      });

      return json({
        data: result.rows,
        nextPage: result.nextPage,
        ...(result.snapshot !== undefined ? { snapshot: result.snapshot } : {}),
        ...(result.deltaCursor !== undefined ? { deltaCursor: result.deltaCursor } : {}),
        ...(result.total !== undefined ? { total: result.total } : {}),
      });
    },
  };
}
