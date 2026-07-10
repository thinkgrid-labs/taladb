import { describe, it, expect, beforeAll } from 'vitest';

// Integration test that drives the real native binding through the same
// aggregate path the unified `taladb` package uses (parse pipeline → engine →
// serialize). Skips gracefully if the prebuilt .node module can't load in this
// environment; CI's build-taladb job builds it first, so it runs there.

type NodeBinding = {
  TalaDbNode: {
    openInMemory(): {
      collection(name: string): {
        insert(doc: Record<string, unknown>): string;
        aggregate(pipeline: unknown[]): Record<string, unknown>[];
      };
    };
  };
};

let binding: NodeBinding | null = null;

beforeAll(async () => {
  try {
    const mod = (await import('@taladb/node')) as unknown as NodeBinding;
    binding = typeof mod?.TalaDbNode?.openInMemory === 'function' ? mod : null;
  } catch {
    binding = null;
  }
});

describe('aggregate (native binding)', () => {
  function seed() {
    const db = binding!.TalaDbNode.openInMemory();
    const orders = db.collection('orders');
    for (const o of [
      { status: 'active', amount: 100 },
      { status: 'active', amount: 50 },
      { status: 'active', amount: 25 },
      { status: 'closed', amount: 30 },
    ]) {
      orders.insert(o);
    }
    return orders;
  }

  it('$group with $sum, $sum:1 count, and $sort', () => {
    if (!binding) return; // binding unavailable in this env
    const orders = seed();
    const rows = orders.aggregate([
      { $group: { _id: '$status', total: { $sum: '$amount' }, n: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);
    expect(rows).toEqual([
      { _id: 'active', total: 175, n: 3 },
      { _id: 'closed', total: 30, n: 1 },
    ]);
  });

  it('$match then $group(null) with $avg', () => {
    if (!binding) return;
    const orders = seed();
    const rows = orders.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: null, avg: { $avg: '$amount' }, n: { $sum: 1 } } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(3);
    expect(rows[0].avg).toBeCloseTo(58.333, 2);
  });

  it('rejects an unknown stage', () => {
    if (!binding) return;
    const orders = seed();
    expect(() => orders.aggregate([{ $frobnicate: 1 }])).toThrow(/unsupported stage/);
  });
});
