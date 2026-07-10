import { describe, it, expect, vi } from 'vitest';
import { MongoSyncAdapter } from '../src/index';

// ---------------------------------------------------------------------------
// A fake Mongo collection that *interprets* the pipeline update the adapter
// emits — extracting the $cond true-branch and evaluating the Last-Write-Wins
// comparison — so these tests validate the real pipeline, not just a happy
// round-trip. Integration against a live MongoDB is recommended additionally.
// ---------------------------------------------------------------------------

interface Row {
  _id: string;
  changed_at: number;
  change: string;
}

function makeFakeCollection() {
  const rows = new Map<string, Row>();

  return {
    rows,
    createIndex: vi.fn(async () => 'changed_at_1'),

    async bulkWrite(ops: unknown[], _opts: unknown) {
      for (const op of ops as {
        updateOne: {
          filter: { _id: string };
          update: [{ $replaceWith: { $cond: [unknown, Row, string] } }];
          upsert: boolean;
        };
      }[]) {
        const { filter, update } = op.updateOne;
        const cond = update[0].$replaceWith.$cond;
        const incoming = cond[1]; // the { _id, changed_at, change } literal
        const existing = rows.get(filter._id);
        // Mirror: $gt: [incoming.changed_at, $ifNull($changed_at, -1)]
        const stored = existing?.changed_at ?? -1;
        if (incoming.changed_at > stored) {
          rows.set(filter._id, incoming);
        }
      }
      return { ok: 1 };
    },

    find(query: { changed_at: { $gt: number } }) {
      const since = query.changed_at.$gt;
      let result = [...rows.values()].filter((r) => r.changed_at > since);
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

    expect(fake.rows.has('notes::01A')).toBe(true);
    expect(fake.rows.has('tasks::01B')).toBe(true);

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

    const stored = JSON.parse(fake.rows.get('notes::01A')!.change);
    expect(stored.op.Upsert.body).toBe('newer');
    expect(stored.changed_at).toBe(2000);
  });

  it('a newer change does overwrite an older stored one', async () => {
    const fake = makeFakeCollection();
    const adapter = new MongoSyncAdapter({ collection: fake as never });
    await adapter.push(JSON.stringify([change('notes', '01A', 1000, { body: 'v1' })]));
    await adapter.push(JSON.stringify([change('notes', '01A', 3000, { body: 'v2' })]));
    const stored = JSON.parse(fake.rows.get('notes::01A')!.change);
    expect(stored.op.Upsert.body).toBe('v2');
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
