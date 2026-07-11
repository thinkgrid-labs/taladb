// Compound index e2e against the real native engine — exercises the full
// createCompoundIndex path: TS adapter → @taladb/node → taladb-core.
// Skipped when the native module isn't built.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB } from '../src/index';

let nativeAvailable = true;
try {
  await import('@taladb/node');
} catch {
  nativeAvailable = false;
}

interface Order {
  _id?: string;
  userId: string;
  status: string;
  total: number;
  [key: string]: string | number | undefined;
}

describe.skipIf(!nativeAvailable)('compound index (native engine)', () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof openDB>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'taladb-compound-'));
    db = await openDB(join(dir, 'c.db'));
  });
  afterAll(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createCompoundIndex accelerates a multi-field equality query, matching results', async () => {
    const orders = db.collection<Order>('orders');
    const users = ['u1', 'u2', 'u3'];
    const statuses = ['open', 'shipped', 'closed'];
    // insertMany = one transaction (individual inserts each fsync, ~48/s).
    await orders.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        userId: users[i % 3],
        status: statuses[i % 3],
        total: i,
      })),
    );

    // Baseline (unindexed) result for the exact-match query.
    const before = await orders.find({ userId: 'u1', status: 'open' });

    await orders.createCompoundIndex(['userId', 'status']);

    const after = await orders.find({ userId: 'u1', status: 'open' });

    // Same documents, index or not.
    expect(after.length).toBe(before.length);
    expect(after.length).toBeGreaterThan(0);
    for (const doc of after) {
      expect(doc.userId).toBe('u1');
      expect(doc.status).toBe('open');
    }
    const idsBefore = before.map((d) => d._id).sort();
    const idsAfter = after.map((d) => d._id).sort();
    expect(idsAfter).toEqual(idsBefore);
  });

  it('survives writes and drops cleanly', async () => {
    const c = db.collection<Order>('orders2');
    await c.createCompoundIndex(['userId', 'status']);
    const id = await c.insert({ userId: 'z', status: 'open', total: 1 });
    expect(await c.find({ userId: 'z', status: 'open' })).toHaveLength(1);
    await c.updateOne({ _id: id }, { $set: { status: 'closed' } });
    expect(await c.find({ userId: 'z', status: 'open' })).toHaveLength(0);
    expect(await c.find({ userId: 'z', status: 'closed' })).toHaveLength(1);
    await c.dropCompoundIndex(['userId', 'status']);
    // After drop, the same query still returns correct results (full scan).
    expect(await c.find({ userId: 'z', status: 'closed' })).toHaveLength(1);
  });
});
