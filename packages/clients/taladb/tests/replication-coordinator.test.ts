import { beforeEach, describe, expect, it } from 'vitest';
import { deriveDocId } from '../src/derive-id';
import { ReplicationCoordinator } from '../src/replication/coordinator';
import { CoverageStore, isAuthoritative } from '../src/replication/coverage';
import type {
  BootstrapPage,
  BootstrapRequest,
  DeltaPage,
  ReplicationSource,
} from '../src/replication/source';
import type { Collection, Document, TalaDB } from '../src/types';

/**
 * The coordinator, against a fake origin.
 *
 * The case that matters most is `snapshot consistency`. Without a pinned snapshot,
 * a page walk over live data is not a consistent read: fetch page 1, a row gets
 * inserted, everything shifts down, and the row that *was* going to be on page 2
 * is now on page 1 — which you already passed. It is never fetched. The walk
 * reports success, coverage flips to `complete`, and every subsequent query is
 * served locally from a replica with a silent hole in it. Nothing detects it.
 * That is the failure this whole design is arranged to prevent.
 */

interface Product extends Document {
  sku: string;
  name: string;
  price: number;
}
type Row = { id: string; name: string; price: number; rev: number };

// --------------------------------------------------------------------------
// A tiny in-memory TalaDB: enough of the surface the coordinator actually uses.
// --------------------------------------------------------------------------
class MemDB {
  cols = new Map<string, Map<string, Document>>();

  private store(name: string): Map<string, Document> {
    let c = this.cols.get(name);
    if (!c) {
      c = new Map();
      this.cols.set(name, c);
    }
    return c;
  }

  rows(name: string): Document[] {
    return [...this.store(name).values()];
  }

  collection<T extends Document>(name: string): Collection<T> {
    const store = this.store(name);
    return {
      findOne: async (filter: Record<string, unknown>) =>
        ([...store.values()].find((d) =>
          Object.entries(filter).every(([k, v]) => d[k] === v),
        ) as T) ?? null,
      insert: async (doc: Record<string, unknown>) => {
        const id = `gen-${store.size}`;
        store.set(id, { ...doc, _id: id } as Document);
        return id;
      },
      updateOne: async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => {
        const hit = [...store.values()].find((d) =>
          Object.entries(filter).every(([k, v]) => d[k] === v),
        );
        if (!hit) return false;
        Object.assign(hit, update.$set);
        return true;
      },
      deleteMany: async (filter: Record<string, unknown>) => {
        let n = 0;
        for (const [id, d] of store) {
          if (Object.entries(filter).every(([k, v]) => d[k] === v)) {
            store.delete(id);
            n++;
          }
        }
        return n;
      },
      // The two write primitives the coordinator relies on.
      replaceManyWithIds: async (docs: Document[]) => {
        for (const doc of docs) store.set(doc._id!, { ...doc });
        return docs.map((d) => d._id!);
      },
      deleteManyWithIds: async (ids: string[]) => {
        let n = 0;
        for (const id of ids) if (store.delete(id)) n++;
        return n;
      },
    } as unknown as Collection<T>;
  }
}

const asDb = (m: MemDB) => m as unknown as TalaDB;

// --------------------------------------------------------------------------
// A fake origin whose paging is *live*: rows can be inserted mid-walk.
// --------------------------------------------------------------------------
class FakeOrigin {
  /** Rows in origin order. Mutating this mid-walk is the whole point. */
  rows: Row[];
  /** Snapshots: a frozen copy of `rows` taken when a walk begins. */
  private snapshots = new Map<string, Row[]>();
  private snapshotSeq = 0;
  /** Set false to emulate an origin that cannot pin a consistent snapshot. */
  supportsSnapshots = true;
  bootstrapCalls = 0;
  fetchQueryCalls = 0;
  deltas: DeltaPage<Row>[] = [];
  /** Throw on the Nth bootstrap call (1-indexed). 0 = never. */
  failOnCall = 0;

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  bootstrap = async (req: BootstrapRequest): Promise<BootstrapPage<Row>> => {
    this.bootstrapCalls++;
    if (this.failOnCall === this.bootstrapCalls) throw new Error('origin exploded');

    let view: Row[];
    let snapshot: string | undefined;

    if (this.supportsSnapshots) {
      if (req.snapshot === null) {
        // First page: freeze a view and hand back its token.
        snapshot = `snap-${++this.snapshotSeq}`;
        this.snapshots.set(snapshot, [...this.rows]);
      } else {
        snapshot = req.snapshot;
      }
      view = this.snapshots.get(snapshot) ?? [];
    } else {
      // No snapshot: every page reads whatever is live *right now*.
      view = this.rows;
    }

    const offset = req.page === null ? 0 : Number(req.page);
    const slice = view.slice(offset, offset + req.limit);
    const nextOffset = offset + req.limit;
    const done = nextOffset >= view.length;

    return {
      rows: slice,
      nextPage: done ? null : nextOffset,
      ...(this.supportsSnapshots ? { snapshot, deltaCursor: 'delta-0' } : {}),
      total: view.length,
    };
  };

  delta = async (_cursor: string): Promise<DeltaPage<Row>> =>
    this.deltas.shift() ?? { changed: [], deleted: [], cursor: 'delta-final', hasMore: false };

  fetchQuery = async (): Promise<Row[]> => {
    this.fetchQueryCalls++;
    return this.rows.slice(0, 2);
  };
}

function makeSource(origin: FakeOrigin): ReplicationSource<Row, Product> {
  return {
    origin: 'test-origin',
    collection: 'products',
    scope: 'store:1',
    projectionVersion: 1,
    schemaVersion: 1,
    bootstrap: origin.bootstrap,
    delta: origin.delta,
    fetchQuery: origin.fetchQuery,
    keyOf: (row) => row.id,
    revisionOf: (row) => row.rev,
    mapRow: (row) => ({ sku: row.id, name: row.name, price: row.price }),
  };
}

const rowsOf = (n: number, from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `sku-${from + i}`,
    name: `p${from + i}`,
    price: from + i,
    rev: from + i + 1,
  }));

describe('ReplicationCoordinator', () => {
  let db: MemDB;
  beforeEach(() => {
    db = new MemDB();
  });

  const make = (origin: FakeOrigin, pageSize = 2) =>
    new ReplicationCoordinator(asDb(db), makeSource(origin), {
      pageSize,
      yieldFn: async () => {},
    });

  describe('bootstrap', () => {
    it('walks every page and marks the scope complete', async () => {
      const origin = new FakeOrigin(rowsOf(5));
      const state = await make(origin).hydrate();

      expect(state.status).toBe('complete');
      expect(isAuthoritative(state), 'complete must license a local-only read').toBe(true);
      expect(db.rows('products')).toHaveLength(5);
    });

    it('derives ids from the origin key, so rows are addressable', async () => {
      const origin = new FakeOrigin(rowsOf(3));
      await make(origin).hydrate();

      const ids = db.rows('products').map((d) => d._id);
      expect(ids).toContain(deriveDocId('test-origin\0store:1\0products', 'sku-0'));
    });

    it('is idempotent: hydrating twice leaves one copy of each row', async () => {
      const origin = new FakeOrigin(rowsOf(4));
      const coord = make(origin);
      await coord.hydrate();
      await coord.reset();
      await coord.hydrate();

      expect(db.rows('products')).toHaveLength(4);
    });

    it('dedups concurrent hydrate calls into one walk', async () => {
      const origin = new FakeOrigin(rowsOf(4));
      const coord = make(origin);
      await Promise.all([coord.hydrate(), coord.hydrate(), coord.hydrate()]);

      // 2 pages of 2 + a final empty-ish page; the point is it walked *once*.
      expect(origin.bootstrapCalls).toBe(2);
      expect(db.rows('products')).toHaveLength(4);
    });

    it('does not re-walk a scope that is already complete', async () => {
      const origin = new FakeOrigin(rowsOf(4));
      const coord = make(origin);
      await coord.hydrate();
      const after = origin.bootstrapCalls;
      await coord.hydrate();

      expect(origin.bootstrapCalls).toBe(after);
    });
  });

  describe('snapshot consistency', () => {
    it('does not miss a row that shifts between pages mid-walk', async () => {
      // The bug this whole design exists to prevent.
      //
      // Page size 2 over 6 rows. After page 1 is read, a row is **deleted from the
      // front** of the origin, so every later row shifts *up* by one. An unpinned
      // walk then reads page 2 at offset 2 — but the row that was at offset 2 is
      // now at offset 1, which we already passed. It is never fetched. The walk
      // reports success, coverage flips to complete, and every subsequent query is
      // served locally from a replica with a silent hole in it.
      //
      // Note the mutation has to be a *deletion*, not an insertion: an insertion
      // shifts rows later, which merely causes a harmless idempotent re-read. Only
      // a shift toward the front can skip. (An earlier version of this test used
      // an insertion and was therefore vacuous — it passed with no snapshot at all.)
      const origin = new FakeOrigin(rowsOf(6));
      const coord = make(origin, 2);

      const originalBootstrap = origin.bootstrap;
      let mutated = false;
      origin.bootstrap = async (req) => {
        const page = await originalBootstrap(req);
        if (!mutated) {
          mutated = true;
          origin.rows.shift();
        }
        return page;
      };

      const state = await coord.hydrate();
      expect(state.status).toBe('complete');

      // Every row in the pinned snapshot must be present — none skipped.
      const skus = new Set(db.rows('products').map((d) => (d as Product).sku));
      for (const row of rowsOf(6)) {
        expect(skus.has(row.id), `${row.id} was skipped by the mid-walk shift`).toBe(true);
      }
    });

    it('degrades to best-effort when the origin cannot pin a snapshot', async () => {
      const origin = new FakeOrigin(rowsOf(4));
      origin.supportsSnapshots = false;

      const state = await make(origin).hydrate();

      expect(state.status).toBe('best-effort');
      expect(
        isAuthoritative(state),
        'best-effort must NOT license a local-only read — we cannot prove we saw everything',
      ).toBe(false);
    });
  });

  describe('resume', () => {
    it('picks up from the last committed page after a failure', async () => {
      const origin = new FakeOrigin(rowsOf(6));
      origin.failOnCall = 2; // page 1 lands, page 2 dies
      const coord = make(origin, 2);

      await expect(coord.hydrate()).rejects.toThrow('origin exploded');

      const mid = await coord.getCoverage();
      expect(mid.status).toBe('error');
      expect(db.rows('products'), 'page 1 must have been committed').toHaveLength(2);

      // Recover and finish.
      origin.failOnCall = 0;
      const state = await coord.hydrate();

      expect(state.status).toBe('complete');
      expect(db.rows('products'), 'no duplicates, no gaps').toHaveLength(6);
    });

    it('checkpoints after committing a page, so a crash re-fetches rather than skips', async () => {
      const origin = new FakeOrigin(rowsOf(6));
      origin.failOnCall = 3;
      const coord = make(origin, 2);

      await expect(coord.hydrate()).rejects.toThrow();
      const state = await coord.getCoverage();

      // 2 pages committed → 4 rows → resume at offset 4, not past it.
      expect(db.rows('products')).toHaveLength(4);
      expect(state.status === 'error' && state.resumeFrom).toBe(4);
    });

    it('persists the first-page delta cursor across a resumed walk', async () => {
      const origin = new FakeOrigin(rowsOf(6));
      const original = origin.bootstrap;
      origin.bootstrap = async (req) => {
        const result = await original(req);
        if (req.page !== null) delete result.deltaCursor;
        return result;
      };
      origin.failOnCall = 2;
      const coord = make(origin, 2);
      await expect(coord.hydrate()).rejects.toThrow();
      origin.failOnCall = 0;

      const state = await coord.hydrate();
      expect(state.status === 'complete' && state.cursor).toBe('delta-0');
    });
  });

  describe('delta refresh', () => {
    it('applies updates and deletions by remote key', async () => {
      const origin = new FakeOrigin(rowsOf(3));
      const coord = make(origin);
      await coord.hydrate();

      origin.deltas = [
        {
          changed: [{ id: 'sku-0', name: 'renamed', price: 999, rev: 999 }],
          deleted: ['sku-1'],
          cursor: 'delta-1',
          hasMore: false,
        },
      ];
      await coord.refresh();

      const rows = db.rows('products') as Product[];
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.sku === 'sku-0')?.price).toBe(999);
      expect(
        rows.find((r) => r.sku === 'sku-1'),
        'a deleted row must actually be removed — REST replicas learn deletes only here',
      ).toBeUndefined();
    });

    it('advances the cursor across multiple delta pages', async () => {
      const origin = new FakeOrigin(rowsOf(2));
      const coord = make(origin);
      await coord.hydrate();

      origin.deltas = [
        { changed: [], deleted: [], cursor: 'd1', hasMore: true },
        { changed: [], deleted: [], cursor: 'd2', hasMore: false },
      ];
      const state = await coord.refresh();

      expect(state.status === 'complete' && state.cursor).toBe('d2');
    });

    it('does not refresh a scope that never completed', async () => {
      const origin = new FakeOrigin(rowsOf(4));
      const coord = make(origin);
      const state = await coord.refresh();

      expect(state.status).toBe('empty');
      expect(origin.bootstrapCalls).toBe(0);
    });
  });

  describe('bridge', () => {
    it('merges into the replica rather than caching beside it', async () => {
      // The composition claim: bridged rows and hydrated rows are the same rows.
      // If the ids diverged, this would end with 2 copies of sku-0 and sku-1.
      const origin = new FakeOrigin(rowsOf(5));
      const coord = make(origin);

      await coord.bridge({ page: 1, limit: 2 });
      expect(db.rows('products')).toHaveLength(2);

      await coord.hydrate();

      expect(
        db.rows('products'),
        'the walk must overwrite the bridged rows in place, not duplicate them',
      ).toHaveLength(5);
    });

    it('does not advance coverage', async () => {
      // A page-1 fetch must never masquerade as a hydrated catalog.
      const origin = new FakeOrigin(rowsOf(5));
      const coord = make(origin);

      await coord.bridge({ page: 1, limit: 2 });
      const state = await coord.getCoverage();

      expect(state.status).toBe('empty');
      expect(isAuthoritative(state)).toBe(false);
      expect(await coord.isReady()).toBe(false);
    });

    it('dedups identical concurrent bridge fetches', async () => {
      const origin = new FakeOrigin(rowsOf(5));
      const coord = make(origin);

      await Promise.all([
        coord.bridge({ page: 1, limit: 2 }),
        coord.bridge({ page: 1, limit: 2 }),
      ]);

      expect(origin.fetchQueryCalls).toBe(1);
    });
  });

  describe('coverage scoping', () => {
    it('does not let one scope inherit another scope’s completeness', async () => {
      // Log in as someone else and you must not inherit their "complete" flag.
      const origin = new FakeOrigin(rowsOf(3));
      const coordA = make(origin);
      await coordA.hydrate();
      expect(await coordA.isReady()).toBe(true);

      const store = new CoverageStore(asDb(db));
      const scopeB = {
        origin: 'test-origin',
        collection: 'products',
        scope: 'store:2', // a different tenant
        projectionVersion: 1,
        schemaVersion: 1,
      };

      expect((await store.read(scopeB)).status).toBe('empty');
    });

    it('namespaces row ids and stamps rows so two scopes cannot overwrite or leak', async () => {
      const origin = new FakeOrigin(rowsOf(2));
      const coordA = make(origin);
      const sourceB = { ...makeSource(origin), scope: 'store:2' };
      const coordB = new ReplicationCoordinator(asDb(db), sourceB, {
        pageSize: 2,
        yieldFn: async () => {},
      });

      await coordA.hydrate();
      await coordB.hydrate();

      const rows = db.rows('products');
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r._replica_scope))).toEqual(
        new Set([coordA.replicaScope, coordB.replicaScope]),
      );
    });

    it('invalidates coverage when the projection changes', async () => {
      const origin = new FakeOrigin(rowsOf(3));
      await make(origin).hydrate();

      const store = new CoverageStore(asDb(db));
      const newProjection = {
        origin: 'test-origin',
        collection: 'products',
        scope: 'store:1',
        projectionVersion: 2, // now hydrating different fields
        schemaVersion: 1,
      };

      expect(
        (await store.read(newProjection)).status,
        'a replica hydrated with a slimmer projection is not complete for a richer one',
      ).toBe('empty');
    });
  });
});
