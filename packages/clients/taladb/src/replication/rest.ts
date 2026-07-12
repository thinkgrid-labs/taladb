/**
 * A {@link ReplicationSource} for an ordinary paged JSON API.
 *
 * This is the adoption path: point it at `GET /api/products?page=1&limit=500` and
 * a team on Express + Postgres gets a local replica without rewriting their API to
 * speak TalaDB's sync contract. Everything here is wire translation — the
 * coordinator owns the walk, the coverage, and the retries.
 *
 * ## What the origin has to provide, and what happens when it doesn't
 *
 * | Feature | Endpoint | Without it |
 * |---|---|---|
 * | Paged list | `?page=&limit=` | Nothing works. Required. |
 * | Snapshot token | `snapshot` in the response | Coverage caps at `best-effort`; reads keep hitting the network |
 * | Delta feed | `?since=<cursor>` | No incremental refresh, and **deletions never propagate** |
 *
 * The snapshot and the delta feed are each about twenty minutes of Express work
 * (a monotonic `updated_at`/revision column, a soft-delete table, and a
 * `rev <= snapshotRev` predicate). They are worth it: without a snapshot the
 * replica can never be trusted for a local-only read, which is the entire point.
 */

import type {
  BootstrapPage,
  BootstrapRequest,
  BridgeQuery,
  DeltaPage,
  RemoteKey,
  ReplicationSource,
} from './source';
import type { Document } from '../types';

/** The response envelopes we recognize without configuration. */
type Envelope = unknown[] | { data?: unknown[]; items?: unknown[]; rows?: unknown[]; [k: string]: unknown };

export interface RestSourceOptions<RemoteRow, T extends Document> {
  /** Base URL, e.g. `/api/products`. */
  endpoint: string;
  /** The local collection to fill. */
  collection: string;
  /** Stable identity for the origin. Defaults to `endpoint`. */
  origin?: string;
  /**
   * The authorization slice these rows belong to — a user id, tenant, or store.
   * Part of the coverage key, so one user's completeness never licenses another
   * user's reads. Defaults to `'global'`; **set it for anything user-scoped.**
   */
  scope?: string;
  /** Bump when {@link mapRow} starts producing a different shape. Default 1. */
  projectionVersion?: number;
  /** Bump when the local schema changes. Default 1. */
  schemaVersion?: number;
  /** Field on the remote row holding its primary key. Default `'id'`. */
  key?: string;
  /** Field/callback yielding a monotonic numeric row revision. Default `'rev'`. */
  revision?: string | ((row: RemoteRow) => number | undefined);
  /** Shape a remote row into a local document. Default: identity, minus `_id`. */
  mapRow?: (row: RemoteRow) => Omit<T, '_id'>;
  /** Per-request headers, resolved **at send time** so a refreshed token is used. */
  getAuth?: () => Promise<Record<string, string>> | Record<string, string>;
  /** `fetch` implementation. Defaults to the global. */
  fetch?: typeof fetch;
  /** Sub-paths appended to `endpoint`. */
  paths?: { bootstrap?: string; delta?: string };
  /** Enable delta polling. Defaults to true only when `paths.delta` is set. */
  delta?: boolean;
  /** Meaning of the fallback `page` parameter when no next token is returned. */
  pagination?: 'page' | 'offset';
  /** Translate a local query into this API's query-string conventions. */
  toParams?: (query: BridgeQuery) => Record<string, string>;
  /** Pull the row array out of a response whose envelope we don't recognize. */
  parse?: (body: unknown) => unknown[];
}

/**
 * Find the row array in a response body.
 *
 * Recognizes a bare array and the `{data}` / `{items}` / `{rows}` envelopes. When
 * it can't tell, it **throws with the keys it actually saw** rather than guessing —
 * a wrong guess here yields an empty replica that reports itself complete, which
 * is far worse than an error at startup.
 */
function parseRows(body: unknown, endpoint: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const env = body as Envelope & object;
    for (const field of ['data', 'items', 'rows'] as const) {
      const value = (env as Record<string, unknown>)[field];
      if (Array.isArray(value)) return value;
    }
    throw new Error(
      `taladb: could not find a row array in the response from ${endpoint}. ` +
        `Expected a bare array or a { data | items | rows } envelope, but got an object with ` +
        `keys: ${Object.keys(env).join(', ') || '(none)'}. Pass { parse } to extract them yourself.`,
    );
  }
  throw new Error(
    `taladb: expected an array or object from ${endpoint}, got ${typeof body}.`,
  );
}

/** Read a number from any of several common field names. */
function pick(body: unknown, names: string[]): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  for (const n of names) {
    if (rec[n] !== undefined) return rec[n];
    const meta = rec.meta as Record<string, unknown> | undefined;
    if (meta && meta[n] !== undefined) return meta[n];
  }
  return undefined;
}

export function createRestSource<RemoteRow = Record<string, unknown>, T extends Document = Document>(
  options: RestSourceOptions<RemoteRow, T>,
): ReplicationSource<RemoteRow, T> {
  const {
    endpoint,
    collection,
    origin = endpoint,
    scope = 'global',
    projectionVersion = 1,
    schemaVersion = 1,
    key = 'id',
    revision = 'rev',
    mapRow,
    getAuth,
    paths,
    toParams,
    parse,
    pagination = 'page',
  } = options;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, globalThis.location?.origin ?? 'http://localhost');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Resolved per request, not baked in at construction: a token that refreshed
    // during a long background walk must be picked up by the next page.
    const headers = getAuth ? await getAuth() : undefined;
    const response = await doFetch(url.href, { headers });
    if (!response.ok) {
      throw new Error(
        `taladb: ${path} responded ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  }

  const rowsFrom = (body: unknown): unknown[] =>
    parse ? parse(body) : parseRows(body, endpoint);

  return {
    origin,
    collection,
    scope,
    projectionVersion,
    schemaVersion,

    keyOf: (row): RemoteKey => {
      const value = (row as Record<string, unknown>)[key];
      if (value === undefined || value === null) {
        throw new Error(
          `taladb: row from ${endpoint} has no '${key}' field to use as its primary key. ` +
            `Pass { key } to name the right one. Without a stable key, repeated fetches ` +
            `of the same row cannot be recognized as the same row.`,
        );
      }
      return String(value);
    },

    revisionOf: (row): number => {
          const value =
            typeof revision === 'function'
              ? revision(row)
              : (row as Record<string, unknown>)[revision];
          if (value === undefined || value === null) {
            throw new Error(
              `taladb: row from ${endpoint} has no authoritative revision. ` +
                `Pass { revision } to name the monotonic revision field.`,
            );
          }
          const n = Number(value);
          if (!Number.isSafeInteger(n)) {
            throw new Error(`taladb: authoritative revision must be a safe integer, got ${String(value)}`);
          }
          return n;
        },

    mapRow: (row) => {
      if (mapRow) return mapRow(row);
      const { _id, ...rest } = row as Record<string, unknown>;
      void _id;
      return rest as Omit<T, '_id'>;
    },

    bootstrap: async (request: BootstrapRequest): Promise<BootstrapPage<RemoteRow>> => {
      const params: Record<string, string> = { limit: String(request.limit) };
      if (request.page !== null) params.page = String(request.page);
      if (request.snapshot !== null) params.snapshot = request.snapshot;

      const body = await get(endpoint + (paths?.bootstrap ?? ''), params);
      const rows = rowsFrom(body) as RemoteRow[];

      const nextPage = pick(body, ['nextPage', 'next_page', 'next']) as
        | string
        | number
        | null
        | undefined;
      const snapshot = pick(body, ['snapshot']) as string | undefined;
      const deltaCursor = pick(body, ['deltaCursor', 'delta_cursor', 'cursor']) as string | undefined;
      const total = pick(body, ['total', 'totalCount', 'count']) as number | undefined;

      return {
        rows,
        // An origin that reports no explicit `nextPage` is treated as exhausted
        // once it returns a short page — the conventional REST behavior.
        nextPage:
          nextPage !== undefined
            ? nextPage
            : rows.length < request.limit
              ? null
              : pagination === 'offset'
                ? Number(request.page ?? 0) + request.limit
                : Number(request.page ?? 1) + 1,
        ...(snapshot !== undefined ? { snapshot } : {}),
        ...(deltaCursor !== undefined ? { deltaCursor } : {}),
        ...(total !== undefined ? { total } : {}),
      };
    },

    ...(options.delta === true || paths?.delta
      ? { delta: async (cursor: string): Promise<DeltaPage<RemoteRow>> => {
      const body = await get(endpoint + (paths?.delta ?? ''), { since: cursor });
      const changed = rowsFrom(body) as RemoteRow[];
      const deleted = (pick(body, ['deleted', 'removed']) as RemoteKey[] | undefined) ?? [];
      const next = pick(body, ['cursor', 'now', 'nextCursor']) as string | undefined;
      return {
        changed,
        deleted: deleted.map(String),
        cursor: next ?? cursor,
        hasMore: Boolean(pick(body, ['hasMore', 'has_more'])),
      };
        } }
      : {}),

    fetchQuery: async (query: BridgeQuery): Promise<RemoteRow[]> => {
      if (!toParams && Object.values(query.filter ?? {}).some((v) => typeof v === 'object' && v !== null)) {
        throw new Error(
          'taladb: bridge filters with operators require RestSourceOptions.toParams; ' +
            'the default translator only supports scalar equality fields.',
        );
      }
      const sortEntry = Object.entries(query.sort ?? {})[0];
      const params = toParams
        ? toParams(query)
        : {
            ...(query.page !== undefined ? { page: String(query.page) } : {}),
            ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
            ...Object.fromEntries(
              Object.entries(query.filter ?? {}).map(([k, v]) => [k, String(v)]),
            ),
            ...(sortEntry
              ? { sort: sortEntry[0], order: sortEntry[1] === -1 ? 'desc' : 'asc' }
              : {}),
          };
      return rowsFrom(await get(endpoint, params)) as RemoteRow[];
    },
  };
}
