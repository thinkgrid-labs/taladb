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

    // Second pass is incremental: nothing new on either side.
    const again = await dbA.sync(adapter, {});
    expect(again.pushed).toBe(0);
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
});
