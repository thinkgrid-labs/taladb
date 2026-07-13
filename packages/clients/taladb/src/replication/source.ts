/**
 * The replication *source* — wire translation, and nothing else.
 *
 * A source knows how to talk to one origin: how to ask for a page, how to ask for
 * changes since a cursor, how to find a row's primary key, and how to shape a row
 * into a document. It owns **no orchestration**: no batching, no yielding, no
 * cursor persistence, no coverage transitions, no retry, no dedup. All of that
 * belongs to the coordinator, which is generic over sources.
 *
 * That split is deliberate. The obvious alternative — make the REST origin a
 * `SyncAdapter` and let `db.sync()` drive it — does not work: a bootstrap of 100k
 * rows would sit inside a single `pull()` call with no way to report progress,
 * pause, resume, or yield to the UI between pages. Orchestration has to live one
 * level up, or it cannot be orchestrated at all.
 */

import type { Document } from '../types';

/** The origin's primary key for a row. Stringified before hashing into an id. */
export type RemoteKey = string;

/** A request for one page of the initial bootstrap walk. */
export interface BootstrapRequest {
  /**
   * Where to resume. `null` on the first call — which is also when the origin is
   * expected to *issue* the snapshot and delta cursor.
   */
  page: string | number | null;
  /**
   * The snapshot token from the first page, echoed back on every subsequent one.
   * `null` on the first call, and on origins that don't support snapshots.
   */
  snapshot: string | null;
  /** Rows per page. */
  limit: number;
}

/** One page of the bootstrap walk. */
export interface BootstrapPage<RemoteRow> {
  rows: RemoteRow[];
  /** Resume token for the next page; `null` when the walk is done. */
  nextPage: string | number | null;
  /**
   * An opaque token pinning every page of this walk to one logical view of the
   * origin.
   *
   * **Omit it and you get `best-effort` coverage, not `complete`.** Without a
   * snapshot, a page walk over live data is not a consistent read: fetch page 1,
   * a row is inserted, everything shifts, and the row that was going to be on
   * page 20 is now on page 19 — which you already passed. It is never seen. The
   * walk still "succeeds", and the replica silently has a hole in it. Since
   * nothing detects that, the honest response is to refuse to call the result
   * complete, and to keep serving reads from the network.
   */
  snapshot?: string;
  /**
   * The cursor to begin the *delta* stream from once the walk finishes. Issued on
   * the first page — i.e. as of the snapshot — so no change made during the walk
   * can slip between "bootstrap ended" and "delta began".
   */
  deltaCursor?: string;
  /** Total rows in scope, when the origin knows it. Drives progress reporting. */
  total?: number;
}

/** One batch of incremental changes since a cursor. */
export interface DeltaPage<RemoteRow> {
  changed: RemoteRow[];
  /**
   * Primary keys the origin has deleted.
   *
   * This is the only way a REST replica learns about deletions. A plain paged GET
   * returns survivors, and a row's *absence* from a response is ambiguous — it may
   * have been deleted, or it may merely have shifted to another page. Guessing
   * would eventually delete live data, so we never infer; the origin must say so.
   */
  deleted: RemoteKey[];
  cursor: string;
  hasMore: boolean;
}

/**
 * Everything the coordinator needs to replicate one collection from one origin.
 *
 * @typeParam RemoteRow - the row shape the origin returns, before mapping.
 * @typeParam T - the local document shape.
 */
export interface ReplicationSource<RemoteRow = unknown, T extends Document = Document> {
  /** Bump when a custom source's behavior changes without changing its metadata. */
  readonly configVersion?: string | number;
  /** Stable identity for this origin. Part of the coverage key. */
  readonly origin: string;
  /** The local collection this source fills. */
  readonly collection: string;
  /**
   * The authorization slice these rows belong to — a user, tenant, or store.
   * Part of the coverage key, so one user's completeness never licenses another's
   * reads. Use a constant for genuinely global data.
   */
  readonly scope: string;
  /** Bump when {@link mapRow} starts producing a different shape. */
  readonly projectionVersion: number;
  /** Bump when the local schema changes in a way hydrated rows must match. */
  readonly schemaVersion: number;

  /** Fetch one page of the initial walk. */
  bootstrap(request: BootstrapRequest): Promise<BootstrapPage<RemoteRow>>;
  /** Fetch changes since `cursor`. Absent when the origin has no delta feed. */
  delta?(cursor: string): Promise<DeltaPage<RemoteRow>>;
  /**
   * Fetch exactly the rows a specific query needs, for the cold-start bridge.
   *
   * Optional. When absent, a query against an un-hydrated scope simply waits for
   * coverage rather than short-circuiting to the network.
   */
  fetchQuery?(query: BridgeQuery): Promise<RemoteRow[]>;

  /** The origin's primary key for a row. Must be stable across fetches. */
  keyOf(row: RemoteRow): RemoteKey;
  /**
   * Monotonic authoritative revision for stale-response protection. Strongly
   * recommended whenever bridge/bootstrap/delta requests may overlap.
   */
  revisionOf(row: RemoteRow): number;
  /** Shape a remote row into a local document (minus `_id`, which is derived). */
  mapRow(row: RemoteRow): Omit<T, '_id'>;
}

/**
 * A local query, handed to the bridge so it can ask the origin for the same rows.
 *
 * Deliberately loose: every REST API spells pagination and filtering differently,
 * so translating this into a query string is the source's job, not ours.
 */
export interface BridgeQuery {
  filter?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  page?: number;
  limit?: number;
}
