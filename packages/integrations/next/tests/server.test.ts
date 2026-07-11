// createSyncHandlers + built-in stores, exercised with standard Request
// objects — exactly what Next.js route handlers receive. The taladb-backed
// store runs against the real native engine (skipped if the binary isn't
// built).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSyncHandlers,
  memorySyncStore,
  taladbSyncStore,
  type SyncStore,
} from '../src/server';

let nativeAvailable = true;
try {
  await import('@taladb/node');
} catch {
  nativeAvailable = false;
}

const record = (id: string, changed_at: number, body = 'x') => ({
  collection: 'notes',
  id,
  changed_at,
  op: { Upsert: { body } },
});

const push = (handlers: ReturnType<typeof createSyncHandlers>, records: unknown, headers = {}) =>
  handlers.POST(
    new Request('http://x/api/sync/push', {
      method: 'POST',
      headers,
      body: typeof records === 'string' ? records : JSON.stringify(records),
    }),
  );

const pull = async (
  handlers: ReturnType<typeof createSyncHandlers>,
  since = 0,
  headers = {},
) => {
  const res = await handlers.GET(
    new Request(`http://x/api/sync/pull?since=${since}`, { headers }),
  );
  return { res, records: res.status === 200 ? JSON.parse(await res.text()) : null };
};

function storeContractTests(makeStore: () => SyncStore | Promise<SyncStore>) {
  it('round-trips a push and pull', async () => {
    const handlers = createSyncHandlers({ store: await makeStore() });
    expect((await push(handlers, [record('a', 100)])).status).toBe(204);

    const { records } = await pull(handlers);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('a');
    expect(records[0].op.Upsert.body).toBe('x'); // record stored verbatim
  });

  it('keeps the newest change per document (LWW)', async () => {
    const handlers = createSyncHandlers({ store: await makeStore() });
    await push(handlers, [record('a', 200, 'new')]);
    await push(handlers, [record('a', 100, 'stale')]); // out-of-order arrival
    await push(handlers, [record('a', 300, 'newest')]);

    const { records } = await pull(handlers);
    expect(records).toHaveLength(1);
    expect(records[0].changed_at).toBe(300);
    expect(records[0].op.Upsert.body).toBe('newest');
  });

  it('pull filters by since (exclusive)', async () => {
    const handlers = createSyncHandlers({ store: await makeStore() });
    await push(handlers, [record('a', 100), record('b', 200)]);

    expect((await pull(handlers, 100)).records.map((r: { id: string }) => r.id)).toEqual(['b']);
    expect((await pull(handlers, 200)).records).toEqual([]);
  });

  it('isolates scopes from each other', async () => {
    const handlers = createSyncHandlers({
      store: await makeStore(),
      authorize: (req) => req.headers.get('x-user'),
    });
    await push(handlers, [record('a', 100)], { 'x-user': 'alice' });
    await push(handlers, [record('b', 100)], { 'x-user': 'bob' });

    const alice = await pull(handlers, 0, { 'x-user': 'alice' });
    expect(alice.records.map((r: { id: string }) => r.id)).toEqual(['a']);
    const bob = await pull(handlers, 0, { 'x-user': 'bob' });
    expect(bob.records.map((r: { id: string }) => r.id)).toEqual(['b']);
  });
}

describe('createSyncHandlers + memorySyncStore', () => {
  storeContractTests(() => memorySyncStore());

  it('rejects unauthorized callers with 401', async () => {
    const handlers = createSyncHandlers({
      store: memorySyncStore(),
      authorize: (req) => req.headers.get('x-user'), // null without the header
    });
    expect((await push(handlers, [record('a', 1)])).status).toBe(401);
    expect((await pull(handlers)).res.status).toBe(401);
  });

  it('rejects malformed changesets with 400', async () => {
    const handlers = createSyncHandlers({ store: memorySyncStore() });
    expect((await push(handlers, 'not json {')).status).toBe(400);
    expect((await push(handlers, { not: 'an array' })).status).toBe(400);
    expect((await push(handlers, [{ collection: 'c' }])).status).toBe(400); // missing id/changed_at
  });

  it('rejects an invalid since parameter with 400', async () => {
    const handlers = createSyncHandlers({ store: memorySyncStore() });
    const res = await handlers.GET(new Request('http://x/pull?since=abc'));
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!nativeAvailable)('taladbSyncStore (real engine)', () => {
  let dir: string;
  let db: import('taladb').TalaDB;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'taladb-next-store-'));
    const { openDB } = await import('taladb');
    db = await openDB(join(dir, 'hub.db'));
  });

  afterAll(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A fresh scope per store keeps the shared db reusable across the contract
  // tests; scope isolation itself is asserted inside the suite.
  storeContractTests(() => {
    const unique = `s-${Math.random().toString(36).slice(2)}`;
    const inner = taladbSyncStore(db, `changes_${unique}`);
    return inner;
  });
});
