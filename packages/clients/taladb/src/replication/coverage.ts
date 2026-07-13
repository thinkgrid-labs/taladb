/**
 * Coverage — "is this collection complete enough, locally, to answer a query
 * without the network?"
 *
 * This is the question the whole coverage-first design turns on, and it is *not*
 * "have I fetched this page?". A replica assembled from whichever pages a user
 * happened to visit is an arbitrary partial subset: it cannot answer a query
 * nobody has asked yet ("products under ₱500" may live on page 43), so every new
 * filter or sort still goes to the network and the local database buys you almost
 * nothing. Coverage is what licenses a purely local read.
 *
 * Two things make it trustworthy:
 *
 * 1. **It is scoped, not per-collection.** `complete` for a bare collection name
 *    would leak across users: log in as someone else and you inherit the previous
 *    user's "complete" flag *and* their rows. The key is a tuple.
 * 2. **It is a state machine, not a boolean.** Only `complete` authorizes a
 *    local-only read. `best-effort` exists precisely so an origin that *cannot*
 *    give us a consistent snapshot degrades honestly instead of claiming a
 *    completeness it never established.
 */

import type { Collection, Document, TalaDB } from '../types';
import { deriveDocId } from '../derive-id';

/** Reserved collection holding one coverage document per replicated scope. */
export const COVERAGE_COLLECTION = '__taladb_replica';

/**
 * What identifies a replicated scope. Every component must be part of the key,
 * because each one changes what "complete" means:
 *
 * - `origin` — two origins are two different datasets.
 * - `collection` — the local collection being filled.
 * - `scope` — the *authorization* slice (a user, a tenant, a store). This is the
 *   one that bites: without it, user B logging in inherits user A's completeness.
 * - `projectionVersion` — a replica hydrated with a slimmer projection is not
 *   complete for a query that needs the dropped fields.
 * - `schemaVersion` — rows hydrated under an older shape may not satisfy today's.
 */
export interface CoverageKey {
  origin: string;
  collection: string;
  scope: string;
  projectionVersion: number;
  schemaVersion: number;
}

export type CoverageState =
  /** Nothing local. */
  | { status: 'empty' }
  /**
   * A bootstrap walk is in progress. `snapshot` pins every page to one logical
   * view of the origin; `nextPage` is the durable resume point.
   */
  | {
      status: 'hydrating';
      snapshot: string;
      nextPage: string | number;
      rowsApplied: number;
      deltaCursor?: string;
      total?: number;
    }
  /**
   * The scope is fully local as of `cursor`. **The only state that permits a
   * local-only read.**
   */
  | { status: 'complete'; cursor: string; completedAt: number; rowsApplied: number; total?: number }
  /**
   * Every row the origin offered was applied, but the origin could not pin a
   * snapshot, so we cannot *prove* we saw a consistent view — a row that shifted
   * between pages mid-walk may have been missed. Reads must not treat this as
   * authoritative.
   */
  | { status: 'best-effort'; cursor: string; reason: string; rowsApplied: number; total?: number }
  /** Complete once, but known to have fallen behind (e.g. a projection change). */
  | { status: 'stale'; cursor: string; reason: string }
  /** The walk failed. `resumeFrom` is where to pick it up. */
  | {
      status: 'error';
      resumeFrom: string | number;
      snapshot?: string;
      deltaCursor?: string;
      rowsApplied?: number;
      total?: number;
      error: string;
    };

/** The coverage document as stored. `key` is a plain field, never `_id`. */
interface CoverageDoc extends Document {
  key: string;
  state: string;
}

/**
 * Serialize a {@link CoverageKey} into a stable string.
 *
 * Field order is fixed rather than derived from `Object.keys`, so the key cannot
 * change meaning if someone reorders the interface — a silent coverage reset,
 * which would look like "the app re-downloads everything for no reason".
 */
export function coverageKey(key: CoverageKey): string {
  return [
    key.origin,
    key.collection,
    key.scope,
    `p${key.projectionVersion}`,
    `s${key.schemaVersion}`,
  ]
    .map(encodeURIComponent)
    .join('|');
}

/**
 * Persistent coverage state, one document per scope.
 *
 * The state is stored as a JSON string rather than as structured fields: it is a
 * discriminated union whose shape varies per variant, and TalaDB documents are
 * flat. Writing it whole also makes each transition a single atomic write, which
 * is what lets `markComplete` be the durable commit point of a bootstrap.
 */
export class CoverageStore {
  private readonly col: Collection<CoverageDoc>;

  constructor(db: TalaDB) {
    this.col = db.collection<CoverageDoc>(COVERAGE_COLLECTION);
  }

  async read(key: CoverageKey): Promise<CoverageState> {
    const doc = await this.col.findOne({ key: coverageKey(key) } as never);
    if (!doc?.state) return { status: 'empty' };
    try {
      return JSON.parse(doc.state) as CoverageState;
    } catch {
      // A corrupt record must not wedge the app: re-hydrating is always safe
      // (writes are idempotent by derived id), whereas trusting garbage is not.
      return { status: 'empty' };
    }
  }

  async write(key: CoverageKey, state: CoverageState): Promise<void> {
    const k = coverageKey(key);
    const state_json = JSON.stringify(state);
    await this.col.replaceManyWithIds(
      [{ _id: deriveDocId(COVERAGE_COLLECTION, k), key: k, state: state_json }],
      'local',
    );
  }

  /** Drop a scope's coverage, forcing a fresh bootstrap on next use. */
  async clear(key: CoverageKey): Promise<void> {
    const k = coverageKey(key);
    await this.col.deleteManyWithIds([deriveDocId(COVERAGE_COLLECTION, k)], 'local');
  }
}

/**
 * Whether a local-only read is authorized for this state.
 *
 * Deliberately strict: **only `complete`**. `best-effort` is the interesting
 * exclusion — it means we applied everything the origin gave us, but the origin
 * could not pin a snapshot, so a row that moved between pages during the walk may
 * never have been seen. Serving that as authoritative would silently return
 * incomplete results, which is worse than going to the network.
 */
export function isAuthoritative(state: CoverageState): boolean {
  return state.status === 'complete';
}

/** Rows applied so far, for progress reporting. */
export function rowsApplied(state: CoverageState): number {
  switch (state.status) {
    case 'hydrating':
    case 'complete':
    case 'best-effort':
      return state.rowsApplied;
    default:
      return 0;
  }
}

/** Fractional hydration progress, when the origin told us the total. */
export function progress(state: CoverageState): number | undefined {
  if (state.status === 'complete') return 1;
  if (state.status !== 'hydrating' || !state.total) return undefined;
  return Math.min(1, state.rowsApplied / state.total);
}
