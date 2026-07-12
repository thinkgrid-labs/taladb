// End-to-end bidirectional sync against the REAL native engine and a REAL
// HTTP server — no mocks. Guards the full path the unit tests in sync.test.ts
// deliberately skip: openDB → native binding → cursor persistence in
// `__taladb_sync` → HttpSyncAdapter over the wire.
//
// Regression: 0.8.4 shipped with `db.sync()` throwing InvalidName on its first
// pass, because the reserved-name validation rejected the cursor collection —
// the mocked unit tests couldn't catch it. This suite can.
//
// Skipped automatically when the native module isn't built
// (`pnpm --filter @taladb/node build`).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, HttpSyncAdapter } from '../src/index';
import type { TalaDB } from '../src/index';

let nativeAvailable = true;
try {
  await import('@taladb/node');
} catch {
  nativeAvailable = false;
}

interface ChangeRecord {
  collection: string;
  id: string;
  changed_at: number;
}

/** The reference sync server from the docs: LWW upsert per doc on /push,
 * `changed_at > since` filter on /pull. */
function startSyncServer(): Promise<{ server: Server; endpoint: string; store: Map<string, ChangeRecord> }> {
  const store = new Map<string, ChangeRecord>();
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/sync/push') {
      let body = '';
      for await (const chunk of req) body += chunk;
      for (const change of JSON.parse(body) as ChangeRecord[]) {
        const key = `${change.collection}::${change.id}`;
        const existing = store.get(key);
        if (!existing || change.changed_at > existing.changed_at) store.set(key, change);
      }
      res.writeHead(204).end();
    } else if (req.method === 'GET' && req.url?.startsWith('/sync/pull')) {
      const since = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...store.values()].filter((c) => c.changed_at > since)));
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, endpoint: `http://127.0.0.1:${addr.port}/sync`, store });
    });
  });
}

describe.skipIf(!nativeAvailable)('bidirectional sync e2e (native engine + HTTP)', () => {
  let dir: string;
  let server: Server;
  let endpoint: string;
  let store: Map<string, ChangeRecord>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'taladb-sync-e2e-'));
    ({ server, endpoint, store } = await startSyncServer());
  });

  afterAll(async () => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('syncs device A → server → device B, with a working cursor', async () => {
    const dbA = await openDB(join(dir, 'a.db'));
    const dbB = await openDB(join(dir, 'b.db'));
    const adapter = new HttpSyncAdapter({ endpoint });

    await dbA.collection('notes').insert({ title: 'from A', body: 'hello' });

    // First pass on A: pushes the insert. This line threw InvalidName in 0.8.4.
    const passA = await dbA.sync(adapter, {});
    expect(passA.pushed).toBe(1);
    expect(store.size).toBe(1);

    // B pulls it.
    const passB = await dbB.sync(adapter, {});
    expect(passB.pulled).toBe(1);
    const docs = await dbB.collection('notes').find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('from A');

    // Timestamp-only adapters replay from zero to avoid skipping racing or
    // late-arriving writes. The outbound change is counted, while LWW makes
    // the replay a no-op when imported.
    const again = await dbA.sync(adapter, {});
    expect(again.pushed).toBe(1);
    expect(again.pulled).toBe(0);

    await dbA.close();
    await dbB.close();
  });

  it('converges concurrent edits by Last-Write-Wins', async () => {
    const dbA = await openDB(join(dir, 'c.db'));
    const dbB = await openDB(join(dir, 'd.db'));
    const adapter = new HttpSyncAdapter({ endpoint });

    // Seed a doc from A to B via the server.
    const id = await dbA.collection('tasks').insert({ title: 'seed', status: 'open' });
    await dbA.sync(adapter, { collections: ['tasks'] });
    await dbB.sync(adapter, { collections: ['tasks'] });

    // Concurrent edits: A first, B later (strictly newer changed_at).
    await dbA.collection('tasks').updateOne({ _id: id }, { $set: { status: 'a-wins?' } });
    await new Promise((r) => setTimeout(r, 5));
    await dbB.collection('tasks').updateOne({ _id: id }, { $set: { status: 'b-wins' } });

    await dbA.sync(adapter, { collections: ['tasks'] });
    await dbB.sync(adapter, { collections: ['tasks'] });
    await dbA.sync(adapter, { collections: ['tasks'] }); // A picks up B's newer write

    const [a] = await dbA.collection('tasks').find({ _id: id });
    const [b] = await dbB.collection('tasks').find({ _id: id });
    expect(a.status).toBe('b-wins');
    expect(b.status).toBe('b-wins');

    await dbA.close();
    await dbB.close();
  });

  it('validates on import: quarantines a bad-shape doc, applies the valid one', async () => {
    const dbA = await openDB(join(dir, 'e.db'));
    const dbB = await openDB(join(dir, 'f.db'));
    const adapter = new HttpSyncAdapter({ endpoint });

    // B models `articles` with a tolerant sync schema requiring a string `body`.
    dbB.collection('articles', {
      syncSchema: { version: 1, required: ['body'], types: { body: 'str' } },
    });

    // A (no schema) writes one valid and one body-less article.
    await dbA.collection('articles').insert({ title: 'good', body: 'hello', _v: 1 });
    await dbA.collection('articles').insert({ title: 'bad', _v: 1 }); // no body
    await dbA.sync(adapter, { collections: ['articles'] });

    const passB = await dbB.sync(adapter, { collections: ['articles'] });
    // Note: the reference server's store is shared across tests in this suite,
    // so `pulled` also counts docs from earlier tests; only the validated
    // `articles` behaviour is asserted precisely here.
    expect(passB.pulled).toBeGreaterThanOrEqual(1); // the valid article applied
    expect(passB.quarantined).toBe(1); // the body-less one set aside

    const live = await dbB.collection('articles').find({});
    expect(live).toHaveLength(1);
    expect(live[0].title).toBe('good');

    const held = await dbB.quarantined!('articles');
    expect(held).toHaveLength(1);
    expect(held[0].reason).toContain('body');
    expect(held[0].document.title).toBe('bad');

    await dbA.close();
    await dbB.close();
  });
});

describe.skipIf(!nativeAvailable)('openDB({ migrations }) e2e (native engine)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'taladb-migrations-e2e-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Note: reopen-after-close on the *same* path within one process is avoided
  // here — JS GC doesn't deterministically release the native file lock between
  // a close() and the next open() (the sync tests above sidestep it the same
  // way, one path per db). Cross-reopen persistence of the version counter is
  // proven deterministically in the Rust core test `user_version_*`; the
  // runner's ordering/checkpoint/skip logic is unit-tested in migrations.test.ts.
  it('runs pending migrations in ascending order and applies their effects', async () => {
    const path = join(dir, 'm.db');
    const ran: number[] = [];
    // Deliberately out of order to prove the runner sorts by version.
    const migrations = [
      { version: 2, up: async (db: TalaDB) => { ran.push(2); await db.collection('users').insert({ email: 'a@b.c', role: 'user' }); } },
      { version: 1, up: async (db: TalaDB) => { ran.push(1); await db.collection('users').createIndex('email'); } },
    ];

    const db = await openDB(path, { migrations });
    expect(ran).toEqual([1, 2]); // sorted ascending despite declaration order
    // v1 created the index and v2 inserted through it — both effects present.
    expect(await db.collection('users').count({})).toBe(1);
    const [user] = await db.collection('users').find({ email: 'a@b.c' });
    expect(user?.role).toBe('user');
    await db.close();
  });

  it('a failing migration propagates and stops the run', async () => {
    const path = join(dir, 'fail.db');
    const ran: number[] = [];
    const boom = [
      { version: 1, up: async (db: TalaDB) => { ran.push(1); await db.collection('c').insert({ n: 1 }); } },
      { version: 2, up: async () => { ran.push(2); throw new Error('boom'); } },
      { version: 3, up: async () => { ran.push(3); } },
    ];
    await expect(openDB(path, { migrations: boom })).rejects.toThrow('boom');
    expect(ran).toEqual([1, 2]); // v1 applied, v2 threw, v3 never ran
  });
});
