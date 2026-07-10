import { describe, it, expect, vi } from 'vitest';
import { runSync, type SyncHandle } from '../src/sync';
import { HttpSyncAdapter } from '../src/http-adapter';
import type { SyncAdapter } from '../src/index';

// ---------------------------------------------------------------------------
// In-memory SyncHandle that mirrors the real changeset/LWW semantics, so the
// orchestration (cursor, direction, pull-then-push, idempotency) is tested
// against realistic behaviour without loading the native binary. The engine's
// own export/import/merge is proven separately in Rust (tests/sync.rs).
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  changed_at: number;
  body: string;
}

class MemHandle implements SyncHandle {
  private rows = new Map<string, Row & { collection: string }>();
  private cursors = new Map<string, number>();

  put(id: string, body: string, changed_at: number, collection = 'notes') {
    this.rows.set(id, { id, changed_at, body, collection });
  }
  get(id: string) {
    return this.rows.get(id)?.body;
  }
  size() {
    return this.rows.size;
  }

  // Respects the collections filter, so collection-resolution is testable.
  exportChanges = async (collections: string[], sinceMs: number): Promise<string> => {
    const include = new Set(collections);
    const out = [...this.rows.values()]
      .filter((r) => r.changed_at > sinceMs && include.has(r.collection))
      .map((r) => ({
        collection: r.collection,
        id: r.id,
        op: { Upsert: { body: r.body } },
        changed_at: r.changed_at,
      }));
    return JSON.stringify(out);
  };

  importChanges = async (changeset: string): Promise<number> => {
    const changes = JSON.parse(changeset) as {
      collection: string;
      id: string;
      changed_at: number;
      op: { Upsert: { body: string } };
    }[];
    let applied = 0;
    for (const c of changes) {
      const existing = this.rows.get(c.id);
      if (!existing || c.changed_at > existing.changed_at) {
        this.rows.set(c.id, {
          id: c.id,
          changed_at: c.changed_at,
          body: c.op.Upsert.body,
          collection: c.collection,
        });
        applied++;
      }
    }
    return applied;
  };

  // User collections present in this database (reserved `_`-prefixed excluded).
  listCollectionNames = async (): Promise<string[]> =>
    [...new Set([...this.rows.values()].map((r) => r.collection))].filter((c) => !c.startsWith('_'));

  // Minimal cursor collection backed by the cursors map.
  collection = (_name: string): never => {
    const cursors = this.cursors;
    return {
      findOne: async (filter: { _id: string }) =>
        cursors.has(filter._id) ? { _id: filter._id, sinceMs: cursors.get(filter._id)! } : null,
      insert: async (doc: { _id: string; sinceMs: number }) => {
        cursors.set(doc._id, doc.sinceMs);
        return doc._id;
      },
      updateOne: async (filter: { _id: string }, update: { $set: { sinceMs: number } }) => {
        cursors.set(filter._id, update.$set.sinceMs);
        return true;
      },
    } as never;
  };
}

/** An adapter that ferries changesets straight into another MemHandle (an
 * in-memory "server"), used to test bidirectional exchange between two peers. */
function memAdapter(server: MemHandle): SyncAdapter {
  return {
    push: async (changeset) => {
      await server.importChanges(changeset);
    },
    pull: async (sinceMs) => server.exportChanges(['notes'], sinceMs),
  };
}

describe('runSync orchestration', () => {
  it('bidirectional: local writes reach the server and server writes reach local', async () => {
    const local = new MemHandle();
    const server = new MemHandle();
    const adapter = memAdapter(server);

    local.put('a', 'from-local', 1000);
    server.put('b', 'from-server', 1500);

    const res = await runSync(local, adapter, { collections: ['notes'] });

    expect(local.get('b')).toBe('from-server'); // pulled
    expect(server.get('a')).toBe('from-local'); // pushed
    expect(res.pulled).toBe(1);
    expect(res.pushed).toBe(1);
  });

  it("direction 'push' only sends; 'pull' only receives", async () => {
    const local = new MemHandle();
    const server = new MemHandle();
    const adapter = memAdapter(server);

    local.put('a', 'x', 1000);
    server.put('b', 'y', 1000);

    await runSync(local, adapter, { collections: ['notes'], direction: 'push', target: 'p' });
    expect(server.get('a')).toBe('x'); // pushed
    expect(local.get('b')).toBeUndefined(); // not pulled

    await runSync(local, adapter, { collections: ['notes'], direction: 'pull', target: 'q' });
    expect(local.get('b')).toBe('y'); // now pulled
  });

  it('advances the cursor so the next pass is incremental', async () => {
    const local = new MemHandle();
    const server = new MemHandle();
    const spy = vi.spyOn(server, 'importChanges');
    const adapter = memAdapter(server);

    local.put('a', 'first', Date.now() - 10_000);
    await runSync(local, adapter, { collections: ['notes'] });
    const firstCallCount = (JSON.parse(spy.mock.calls[0][0]) as unknown[]).length;
    expect(firstCallCount).toBe(1);

    // Second pass with no new local writes must push an empty changeset.
    const res2 = await runSync(local, adapter, { collections: ['notes'] });
    expect(res2.pushed).toBe(0);
  });

  it('rejects a direction whose required adapter method is missing', async () => {
    const local = new MemHandle();
    const pushOnly: SyncAdapter = { push: async () => {} };
    await expect(
      runSync(local, pushOnly, { collections: ['notes'], direction: 'both' }),
    ).rejects.toThrow(/requires adapter.pull/);
  });

  it('syncs ALL collections when `collections` is omitted', async () => {
    const local = new MemHandle();
    const server = new MemHandle();
    local.put('n1', 'note', 1000, 'notes');
    local.put('t1', 'task', 1000, 'tasks');

    const res = await runSync(local, memAdapter(server), {}); // no collections
    expect(res.pushed).toBe(2);
    expect(server.get('n1')).toBe('note');
    expect(server.get('t1')).toBe('task');
  });

  it('`exclude` skips the named collections (sync all-except)', async () => {
    const local = new MemHandle();
    const server = new MemHandle();
    local.put('n1', 'note', 1000, 'notes');
    local.put('l1', 'log', 1000, 'logs');

    const res = await runSync(local, memAdapter(server), { exclude: ['logs'] });
    expect(res.pushed).toBe(1);
    expect(server.get('n1')).toBe('note'); // synced
    expect(server.get('l1')).toBeUndefined(); // excluded
  });

  it('explicit `collections` syncs only those', async () => {
    const local = new MemHandle();
    const server = new MemHandle();
    local.put('n1', 'note', 1000, 'notes');
    local.put('t1', 'task', 1000, 'tasks');

    await runSync(local, memAdapter(server), { collections: ['notes'] });
    expect(server.get('n1')).toBe('note');
    expect(server.get('t1')).toBeUndefined();
  });

  it('never syncs reserved `_`-prefixed collections', async () => {
    const local = new MemHandle();
    const server = new MemHandle();
    local.put('n1', 'note', 1000, 'notes');
    local.put('c1', 'cursor', 1000, '__taladb_sync'); // reserved

    const res = await runSync(local, memAdapter(server), {}); // all
    expect(res.pushed).toBe(1); // only 'notes', not the reserved collection
    expect(server.get('c1')).toBeUndefined();
  });
});

describe('HttpSyncAdapter', () => {
  it('push POSTs the changeset to /push', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const adapter = new HttpSyncAdapter({ endpoint: 'https://x.test/sync', fetch: fetchMock });
    await adapter.push('[{"id":"a"}]');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.test/sync/push',
      expect.objectContaining({ method: 'POST', body: '[{"id":"a"}]' }),
    );
  });

  it('pull GETs /pull with the since cursor and returns the body', async () => {
    const fetchMock = vi.fn(async () => new Response('[{"id":"b"}]', { status: 200 }));
    const adapter = new HttpSyncAdapter({ endpoint: 'https://x.test/sync', fetch: fetchMock });
    const body = await adapter.pull(4200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.test/sync/pull?since=4200',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(body).toBe('[{"id":"b"}]');
  });

  it('treats an empty pull response as no changes', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const adapter = new HttpSyncAdapter({ endpoint: 'https://x.test/sync', fetch: fetchMock });
    expect(await adapter.pull(0)).toBe('[]');
  });

  it('throws on a non-2xx push', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500, statusText: 'boom' }));
    const adapter = new HttpSyncAdapter({ endpoint: 'https://x.test/sync', fetch: fetchMock });
    await expect(adapter.push('[]')).rejects.toThrow(/push failed: 500/);
  });
});
