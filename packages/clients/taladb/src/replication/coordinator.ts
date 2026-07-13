/**
 * The replication coordinator — all orchestration, no wire format.
 *
 * Owns: the bootstrap walk, resume-after-crash, delta refresh, the cold-start
 * bridge, batching, yielding, coverage transitions, and in-flight dedup. The
 * {@link ReplicationSource} it drives owns only wire translation.
 *
 * ## The two mechanisms are one mechanism
 *
 * "Fetch the page the user is looking at" and "import the whole catalog in the
 * background" look like separate features. They are the same primitive with two
 * schedulers: *fetch rows → upsert them by derived id*. Because both write the
 * **same rows under the same ids**, they compose for free — a bridged fetch is not
 * a throwaway cache entry, it is a down payment on the replica, and when the walk
 * later reaches those rows it overwrites them in place instead of duplicating
 * them. Nothing has to reconcile the two.
 *
 * The one thing they do *not* share is coverage. A bridge fetch must never advance
 * the bootstrap cursor, because it did not come from the walk's snapshot and
 * proves nothing about completeness. Trading a little duplicate network for a
 * trustworthy completeness proof is the right side of that bargain.
 */

import { deriveDocId } from '../derive-id';
import type { CollectionOptions, Document, TalaDB } from '../types';
import {
  CoverageStore,
  coverageKey,
  isAuthoritative,
  type CoverageKey,
  type CoverageState,
} from './coverage';
import type { BridgeQuery, ReplicationSource } from './source';

export interface CoordinatorOptions<T extends Document = Document> {
  /** Rows per bootstrap page. Larger = fewer commits, longer stalls. */
  pageSize?: number;
  /**
   * Called between pages so the walk yields. Defaults to a macrotask.
   *
   * This matters more than it looks. Live queries re-run on a 300 ms poll, and on
   * React Native every write is *synchronous on the JS thread* — a tight bootstrap
   * loop starves both, and the UI freezes for the duration of the import.
   */
  yieldFn?: () => Promise<void>;
  /** Fired after each committed page, for progress UI. */
  onProgress?: (state: CoverageState) => void;
  /** Collection schema/migration options registered by the host application. */
  collectionOptions?: CollectionOptions<T>;
}

const DEFAULT_PAGE_SIZE = 500;
const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Guard against an origin that never stops offering pages. */
const MAX_BOOTSTRAP_PAGES = 100_000;
const inflightByDatabase = new WeakMap<object, Map<string, Promise<unknown>>>();

export const REPLICA_SCOPE_FIELD = '_replica_scope';
export const REPLICA_REVISION_FIELD = '_remote_rev';

export interface BridgeResult {
  count: number;
  ids: string[];
}

export class ReplicationCoordinator<RemoteRow, T extends Document> {
  private readonly db: TalaDB;
  private readonly source: ReplicationSource<RemoteRow, T>;
  private readonly coverage: CoverageStore;
  private readonly key: CoverageKey;
  private readonly pageSize: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly onProgress?: (state: CoverageState) => void;
  private readonly collectionOptions?: CollectionOptions<T>;

  /**
   * In-flight passes, keyed by intent. Two components mounting the same query must
   * fire one request, and the background walk must not race the bridge for the
   * same rows — both join the existing promise instead.
   */
  private readonly inflight: Map<string, Promise<unknown>>;

  constructor(
    db: TalaDB,
    source: ReplicationSource<RemoteRow, T>,
    options: CoordinatorOptions<T> = {},
  ) {
    this.db = db;
    this.source = source;
    this.coverage = new CoverageStore(db);
    this.key = {
      origin: source.origin,
      collection: source.collection,
      scope: source.scope,
      projectionVersion: source.projectionVersion,
      schemaVersion: source.schemaVersion,
    };
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.yieldFn = options.yieldFn ?? defaultYield;
    this.onProgress = options.onProgress;
    this.collectionOptions = options.collectionOptions;
    let shared = inflightByDatabase.get(db as object);
    if (!shared) {
      shared = new Map();
      inflightByDatabase.set(db as object, shared);
    }
    this.inflight = shared;
  }

  get replicaScope(): string {
    return coverageKey(this.key);
  }

  private get identityNamespace(): string {
    return `${this.source.origin}\0${this.source.scope}\0${this.source.collection}`;
  }

  getCoverage(): Promise<CoverageState> {
    return this.coverage.read(this.key);
  }

  /** Whether a purely local read is authorized right now. */
  async isReady(): Promise<boolean> {
    return isAuthoritative(await this.getCoverage());
  }

  /** Dedup by intent: identical concurrent work joins rather than duplicating. */
  private dedup<R>(key: string, run: () => Promise<R>): Promise<R> {
    const existing = this.inflight.get(key) as Promise<R> | undefined;
    if (existing) return existing;
    const pass = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, pass);
    return pass;
  }

  /**
   * Write a batch of remote rows into the local collection.
   *
   * One commit for the whole batch, ids derived from the origin's primary key, and
   * `origin: 'remote'` so the rows can never replicate back out at the origin they
   * came from. This is the *only* write path in the coordinator — bootstrap, delta
   * and bridge all funnel through it, which is precisely why they converge instead
   * of conflicting.
   */
  private async applyRows(rows: RemoteRow[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const col = this.db.collection<T>(this.source.collection, this.collectionOptions);
    const docs = rows.map(
      (row) => {
        const revision = this.source.revisionOf(row);
        return ({
          ...this.source.mapRow(row),
          _id: deriveDocId(this.identityNamespace, String(this.source.keyOf(row))),
          [REPLICA_SCOPE_FIELD]: this.replicaScope,
          [REPLICA_REVISION_FIELD]: revision,
        }) as unknown as T;
      },
    );
    await col.replaceManyWithIds(docs, 'remote');
    // Return the requested manifest, not only rows physically rewritten. A
    // same/stale revision is intentionally skipped by the engine but the stored
    // row still belongs to this bridge result and must remain renderable.
    return docs.map((doc) => doc._id!);
  }

  /**
   * Hydrate the scope: walk the origin page by page until the whole collection is
   * local, then mark it complete.
   *
   * Resumable and idempotent. If the walk is interrupted — a reload, a crash, a
   * dead network — the next call picks up from the last committed page, and
   * re-applying a page it already wrote is a no-op because the ids are derived.
   */
  hydrate(): Promise<CoverageState> {
    return this.dedup(`${this.replicaScope}:hydrate`, () => this.runHydrate());
  }

  private async runHydrate(): Promise<CoverageState> {
    let state = await this.coverage.read(this.key);
    if (state.status === 'complete') return state;

    // Resume from a checkpoint, or start fresh.
    let page: string | number | null = null;
    let snapshot: string | null = null;
    let rowsApplied = 0;
    let total: number | undefined;
    let deltaCursor: string | undefined;

    if (state.status === 'hydrating') {
      page = state.nextPage;
      snapshot = state.snapshot;
      rowsApplied = state.rowsApplied;
      total = state.total;
      deltaCursor = state.deltaCursor;
    } else if (state.status === 'error' && state.snapshot) {
      page = state.resumeFrom;
      snapshot = state.snapshot;
      rowsApplied = state.rowsApplied ?? 0;
      total = state.total;
      deltaCursor = state.deltaCursor;
    }

    let snapshotSupported = true;
    let pages = 0;

    try {
      for (;;) {
        const result = await this.source.bootstrap({ page, snapshot, limit: this.pageSize });

        if (snapshot !== null && result.snapshot !== undefined && result.snapshot !== snapshot) {
          throw new Error(
            `replication: origin '${this.source.origin}' changed snapshot token mid-walk`,
          );
        }

        // The origin issues the snapshot and delta cursor on the first page — i.e.
        // as of the same instant the walk begins. Taking the delta cursor *after*
        // the walk instead would leave a gap: anything changed mid-walk would fall
        // between "bootstrap finished" and "delta started", and be lost forever.
        if (snapshot === null && result.snapshot) snapshot = result.snapshot;
        if (result.snapshot === undefined && page === null) snapshotSupported = false;
        if (result.deltaCursor && !deltaCursor) deltaCursor = result.deltaCursor;
        if (result.total !== undefined) total = result.total;

        rowsApplied += (await this.applyRows(result.rows)).length;
        page = result.nextPage;

        if (page !== null) {
          // Checkpoint *after* the rows are committed, so a crash re-fetches this
          // page rather than skipping it. Re-fetching is free (idempotent);
          // skipping silently punches a hole in the replica.
          const next: CoverageState = {
            status: 'hydrating',
            snapshot: snapshot ?? '',
            nextPage: page,
            rowsApplied,
            ...(deltaCursor !== undefined ? { deltaCursor } : {}),
            ...(total !== undefined ? { total } : {}),
          };
          await this.coverage.write(this.key, next);
          this.onProgress?.(next);

          if (++pages >= MAX_BOOTSTRAP_PAGES) {
            throw new Error(
              `replication: origin '${this.source.origin}' offered more than ` +
                `${MAX_BOOTSTRAP_PAGES} bootstrap pages for '${this.source.collection}' — ` +
                'it is probably not advancing nextPage.',
            );
          }
          await this.yieldFn();
          continue;
        }

        // Walk finished.
        if (snapshotSupported && this.source.delta && deltaCursor === undefined) {
          throw new Error(
            `replication: origin '${this.source.origin}' supports delta refresh but did not ` +
              'issue deltaCursor on the first bootstrap page',
          );
        }
        state = snapshotSupported
          ? {
              status: 'complete',
              cursor: deltaCursor ?? '',
              completedAt: Date.now(),
              rowsApplied,
              ...(total !== undefined ? { total } : {}),
            }
          : {
              // Every row the origin offered was applied — but without a snapshot
              // we cannot prove we saw a consistent view of it, so we must not
              // claim completeness. Reads keep going to the network.
              status: 'best-effort',
              cursor: deltaCursor ?? '',
              reason:
                'the origin did not return a snapshot token, so a row that moved ' +
                'between pages during the walk may have been missed',
              rowsApplied,
              ...(total !== undefined ? { total } : {}),
            };
        await this.coverage.write(this.key, state);
        this.onProgress?.(state);
        return state;
      }
    } catch (error) {
      const failed: CoverageState = {
        status: 'error',
        resumeFrom: page ?? 0,
        ...(snapshot ? { snapshot } : {}),
        ...(deltaCursor !== undefined ? { deltaCursor } : {}),
        rowsApplied,
        ...(total !== undefined ? { total } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
      await this.coverage.write(this.key, failed);
      this.onProgress?.(failed);
      throw error;
    }
  }

  /**
   * Apply incremental changes since the stored cursor.
   *
   * Deletions are applied by mapping the origin's primary keys through the same
   * `deriveDocId`, and are written with `origin: 'remote'` so they leave no
   * tombstone — the origin already knows it deleted these, and a tombstone would
   * push its own deletion back at it.
   */
  refresh(): Promise<CoverageState> {
    return this.dedup(`${this.replicaScope}:refresh`, () => this.runRefresh());
  }

  private async runRefresh(): Promise<CoverageState> {
    const state = await this.coverage.read(this.key);
    if (state.status !== 'complete') return state;
    if (!this.source.delta) return state;

    const col = this.db.collection<T>(this.source.collection);
    let cursor = state.cursor;
    let rowsApplied = state.rowsApplied;

    for (;;) {
      const page = await this.source.delta(cursor);
      rowsApplied += (await this.applyRows(page.changed)).length;

      if (page.deleted.length > 0) {
        const ids = page.deleted.map((k) =>
          deriveDocId(this.identityNamespace, String(k)),
        );
        await col.deleteManyWithIds(ids, 'remote');
      }

      cursor = page.cursor;
      const next: CoverageState = { ...state, cursor, rowsApplied };
      await this.coverage.write(this.key, next);
      if (!page.hasMore) {
        this.onProgress?.(next);
        return next;
      }
      await this.yieldFn();
    }
  }

  /**
   * Cold-start bridge: fetch exactly the rows one query needs, right now.
   *
   * Needed because a SPA or React Native app has no server render to paint behind
   * while the replica fills. The rows land in the same collection under the same
   * derived ids as the walk's, so this is not a cache — it is the replica, arriving
   * early.
   *
   * **Does not advance coverage.** These rows did not come from the bootstrap
   * snapshot and prove nothing about completeness; treating them as progress would
   * let a page-1 fetch masquerade as a hydrated catalog.
   */
  bridge(query: BridgeQuery): Promise<BridgeResult> {
    if (!this.source.fetchQuery) return Promise.resolve({ count: 0, ids: [] });
    const key = `bridge:${coverageKey(this.key)}:${JSON.stringify(query)}`;
    return this.dedup(key, async () => {
      const rows = await this.source.fetchQuery!(query);
      const ids = await this.applyRows(rows);
      return { count: ids.length, ids };
    });
  }

  /** Drop coverage and force a fresh bootstrap. Local rows are left alone. */
  async reset(): Promise<void> {
    await this.coverage.clear(this.key);
  }
}
