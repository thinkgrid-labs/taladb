import { describe, it, expect, vi } from 'vitest';
import { MongoSyncAdapter } from '../src/index';

// ---------------------------------------------------------------------------
// A fake Mongo collection that *interprets* the operations the adapter emits —
// `$setOnInsert` upserts keyed by content hash, and the supersede `deleteMany` —
// so these tests validate the real ops, not just a happy round-trip. Integration
// against a live MongoDB is recommended additionally.
// ---------------------------------------------------------------------------

interface Row {
  _id: string;
  doc_key: string;
  changed_at: number;
  change: string;
}

type UpsertOp = {
  updateOne: {
    filter: { _id: string };
    update: { $setOnInsert: Omit<Row, '_id'> };
    upsert: boolean;
  };
};
type DeleteOp = {
  deleteMany: { filter: { doc_key: string; changed_at: { $lt: number } } };
};

function makeFakeCollection() {
  const rows = new Map<string, Row>();

  return {
    rows,
    /** Every row currently held for a synced document. */
    candidates(docKey: string) {
      return [...rows.values()].filter((r) => r.doc_key === docKey);
    },
    createIndex: vi.fn(async () => 'idx'),

    async bulkWrite(ops: unknown[], _opts: unknown) {
      for (const op of ops as (UpsertOp | DeleteOp)[]) {
        if ('updateOne' in op) {
          const { filter, update } = op.updateOne;
          // $setOnInsert: an existing _id is left untouched.
          if (!rows.has(filter._id)) {
            rows.set(filter._id, { _id: filter._id, ...update.$setOnInsert });
          }
        } else {
          const { doc_key, changed_at } = op.deleteMany.filter;
          for (const [id, row] of rows) {
            if (row.doc_key === doc_key && row.changed_at < changed_at.$lt) rows.delete(id);
          }
        }
      }
      return { ok: 1 };
    },

    // Two shapes: push's `{ doc_key: { $in } }` lookup of the stored maximum,
    // and pull's `{ changed_at: { $gt } }` cursor scan.
    find(query: { changed_at?: { $gt: number }; doc_key?: { $in: string[] } }) {
      let result = [...rows.values()];
      if (query.doc_key) {
        const keys = new Set(query.doc_key.$in);
        result = result.filter((r) => keys.has(r.doc_key));
      }
      if (query.changed_at) {
        const since = query.changed_at.$gt;
        result = result.filter((r) => r.changed_at > since);
      }
      return {
        sort() {
          result = result.sort((a, b) => a.changed_at - b.changed_at);
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
  };
}

function change(collection: string, id: string, changedAt: number, body: Record<string, unknown>) {
  return { collection, id, changed_at: changedAt, op: { Upsert: body } };
}

describe('MongoSyncAdapter', () => {
  it('push stores changes keyed by collection::id, then pull returns them', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });

    await adapter.push(
      JSON.stringify([change('notes', '01A', 1000, { body: 'hi' }), change('tasks', '01B', 1500, { title: 't' })]),
    );

    expect(fake.candidates('notes::01A')).toHaveLength(1);
    expect(fake.candidates('tasks::01B')).toHaveLength(1);

    const pulled = JSON.parse(await adapter.pull(0));
    expect(pulled).toHaveLength(2);
    expect(pulled[0].id).toBe('01A'); // sorted by changed_at ascending
  });

  it('push is Last-Write-Wins: an older change never overwrites a newer one', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });

    await adapter.push(JSON.stringify([change('notes', '01A', 2000, { body: 'newer' })]));
    // A late-arriving older change for the same doc must be rejected server-side.
    await adapter.push(JSON.stringify([change('notes', '01A', 1000, { body: 'older' })]));

    const rows = fake.candidates('notes::01A');
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(rows[0].change);
    expect(stored.op.Upsert.body).toBe('newer');
    expect(stored.changed_at).toBe(2000);
  });

  it('a newer change supersedes an older stored one', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });
    await adapter.push(JSON.stringify([change('notes', '01A', 1000, { body: 'v1' })]));
    await adapter.push(JSON.stringify([change('notes', '01A', 3000, { body: 'v2' })]));
    const rows = fake.candidates('notes::01A');
    expect(rows).toHaveLength(1); // the older row is pruned, not just shadowed
    expect(JSON.parse(rows[0].change).op.Upsert.body).toBe('v2');
  });

  // -------------------------------------------------------------------------
  // Equal-timestamp convergence. Core breaks ties by comparing serialized
  // document bytes, so it must *see* every competing candidate. A store that
  // kept only the first arrival at a given timestamp would strand the peer
  // holding the other one — it would reject the server's pick under the same
  // tie-break rule, and never converge.
  // -------------------------------------------------------------------------

  it('keeps every distinct candidate pushed at the same changed_at', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });

    // Two peers, conflicting edits to one doc, same millisecond.
    await adapter.push(JSON.stringify([change('notes', '01A', 5000, { body: 'from-peer-A' })]));
    await adapter.push(JSON.stringify([change('notes', '01A', 5000, { body: 'from-peer-B' })]));

    expect(fake.candidates('notes::01A')).toHaveLength(2);
    const bodies = JSON.parse(await adapter.pull(0)).map(
      (c: { op: { Upsert: { body: string } } }) => c.op.Upsert.body,
    );
    expect(bodies.sort()).toEqual(['from-peer-A', 'from-peer-B']);
  });

  it('every peer pulls the same candidate set regardless of push order', async () => {
    // Three peers push conflicting equal-timestamp versions; run the same set in
    // two opposite arrival orders. Both stores must expose identical candidates,
    // or the peers cannot deterministically agree on a winner.
    const bodiesFor = async (order: string[]) => {
      const fake = makeFakeCollection();
      const adapter = new MongoSyncAdapter({ collection: fake as never });
      for (const body of order) {
        await adapter.push(JSON.stringify([change('notes', '01A', 7000, { body })]));
      }
      const pulled = JSON.parse(await adapter.pull(0)) as { op: { Upsert: { body: string } } }[];
      return pulled.map((c) => c.op.Upsert.body).sort();
    };

    const forward = await bodiesFor(['a', 'b', 'c']);
    const reverse = await bodiesFor(['c', 'b', 'a']);
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(forward).toEqual(reverse);
  });

  it('re-pushing an identical change is idempotent, not a duplicate row', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });
    const chg = JSON.stringify([change('notes', '01A', 5000, { body: 'same' })]);
    await adapter.push(chg);
    await adapter.push(chg); // e.g. a retry, or two peers that already agree
    expect(fake.candidates('notes::01A')).toHaveLength(1);
  });

  it('a newer change clears equal-timestamp candidates it supersedes', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });
    await adapter.push(JSON.stringify([change('notes', '01A', 5000, { body: 'tie-a' })]));
    await adapter.push(JSON.stringify([change('notes', '01A', 5000, { body: 'tie-b' })]));
    await adapter.push(JSON.stringify([change('notes', '01A', 9000, { body: 'winner' })]));

    const rows = fake.candidates('notes::01A');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].change).op.Upsert.body).toBe('winner');
  });

  it('pull filters by the since cursor', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });
    await adapter.push(
      JSON.stringify([change('c', 'a', 1000, {}), change('c', 'b', 2000, {}), change('c', 'd', 3000, {})]),
    );
    const recent = JSON.parse(await adapter.pull(1500));
    expect(recent.map((c: { id: string }) => c.id)).toEqual(['b', 'd']);
  });

  it('empty push is a no-op and empty pull returns []', async () => {
    const fake = makeFakeCollection();
    const bulk = vi.spyOn(fake, 'bulkWrite');
    const adapter = new MongoSyncAdapter({ collection: fake as never });
    await adapter.push('[]');
    expect(bulk).not.toHaveBeenCalled();
    expect(await adapter.pull(0)).toBe('[]');
  });

  it('preserves document bodies with $ and . field names (stored as opaque JSON)', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });
    // Field names that would break if stored as native Mongo sub-documents.
    await adapter.push(JSON.stringify([change('c', 'x', 1000, { '$price': 5, 'a.b': true })]));
    const pulled = JSON.parse(await adapter.pull(0));
    expect(pulled[0].op.Upsert['$price']).toBe(5);
    expect(pulled[0].op.Upsert['a.b']).toBe(true);
  });
});
