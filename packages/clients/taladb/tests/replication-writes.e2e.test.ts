import { describe, expect, it } from 'vitest';
import { deriveDocId } from '../src/derive-id';

/**
 * End-to-end over the **real native engine**, exercising the write primitives the
 * replication coordinator is built on.
 *
 * The `authoritative remote rows never replicate outward` case is the one that
 * matters most. TalaDB's `exportChanges` scans the collection directly — and when
 * the cursor is 0 (which it always is today, because sync cursors are stubbed) it
 * exports *everything*. So without an engine-level guard, hydrating a 100k-row
 * catalog from an origin would push that entire catalog straight back at the
 * origin on the next `db.sync()`, as though the user had typed it all in by hand.
 * Nothing in the type system prevents that; only this test does.
 */

type Col = {
  insert(doc: Record<string, unknown>): string;
  insertMany(docs: Record<string, unknown>[]): string[];
  replaceManyWithIds(docs: Record<string, unknown>[], origin: string): string[];
  deleteManyWithIds(ids: string[], origin: string): number;
  find(filter: unknown): Record<string, unknown>[];
  count(filter: unknown): number;
  aggregate(pipeline: unknown[]): Record<string, unknown>[];
  createIndex(field: string): void;
};
type Db = {
  collection(name: string): Col;
  exportChanges(sinceMs: number, collections: string[]): string;
};
type NodeBinding = { TalaDbNode: { openInMemory(): Db } };

/**
 * Resolved at module scope, not in `beforeAll`: `it.skipIf` is evaluated while the
 * suite is being *collected*, which happens before any hook runs. Loading the
 * binding in a hook would leave it null at collection time and silently skip every
 * case — the failure mode where a green run means nothing was tested at all.
 */
const binding: NodeBinding | null = await (async () => {
  try {
    const mod = (await import('@taladb/node')) as unknown as NodeBinding;
    if (typeof mod?.TalaDbNode?.openInMemory !== 'function') return null;
    // An older prebuilt binary predates these methods; treat it as absent rather
    // than failing with a confusing "not a function".
    const probe = mod.TalaDbNode.openInMemory().collection('probe');
    return typeof probe.replaceManyWithIds === 'function' ? mod : null;
  } catch {
    return null;
  }
})();

const maybe = () => it.skipIf(!binding);

/** A remote row as the coordinator builds it: origin fields + a derived `_id`. */
function remoteRow(collection: string, key: string, fields: Record<string, unknown>) {
  return { ...fields, _id: deriveDocId(collection, key) };
}

describe('replication write primitives (native engine)', () => {
  maybe()('never replicates authoritative-remote rows back out', () => {
    const db = binding!.TalaDbNode.openInMemory();
    const products = db.collection('products');

    products.replaceManyWithIds(
      [
        remoteRow('products', 'sku-1', { name: 'Mug', price: 300 }),
        remoteRow('products', 'sku-2', { name: 'Pan', price: 900 }),
      ],
      'remote',
    );
    expect(products.count(null)).toBe(2);

    // sinceMs = 0 is the "export everything" path — exactly what runSync uses today.
    const changeset = JSON.parse(db.exportChanges(0, ['products']));
    expect(
      changeset,
      'a hydrated catalog must not be pushed back at the origin it came from',
    ).toHaveLength(0);
  });

  maybe()('still replicates ordinary local writes', () => {
    const db = binding!.TalaDbNode.openInMemory();
    const notes = db.collection('notes');
    notes.insert({ body: 'hello' });

    const changeset = JSON.parse(db.exportChanges(0, ['notes']));
    expect(changeset, 'the guard must not break normal sync').toHaveLength(1);
  });

  maybe()('is idempotent: re-fetching the same row converges on one document', () => {
    // The bridge fetches page 1; later the background walk reaches page 1 too.
    // Both write the same rows. Without a derived id this silently doubles them.
    const db = binding!.TalaDbNode.openInMemory();
    const products = db.collection('products');
    const row = () => remoteRow('products', 'sku-1', { name: 'Mug' });

    const first = products.replaceManyWithIds([row()], 'remote');
    const second = products.replaceManyWithIds([row()], 'remote');

    expect(first).toEqual(second);
    expect(products.count(null)).toBe(1);
  });

  maybe()('merges pages instead of overwriting them', () => {
    const db = binding!.TalaDbNode.openInMemory();
    const products = db.collection('products');

    products.replaceManyWithIds([remoteRow('products', 'sku-1', { page: 1 })], 'remote');
    products.replaceManyWithIds([remoteRow('products', 'sku-2', { page: 2 })], 'remote');

    expect(products.count(null), 'page 2 must not wipe page 1').toBe(2);
  });

  maybe()('replaces a row in place on refresh, and maintains its indexes', () => {
    const db = binding!.TalaDbNode.openInMemory();
    const products = db.collection('products');
    products.createIndex('category');

    products.replaceManyWithIds(
      [remoteRow('products', 'sku-1', { category: 'kitchen' })],
      'remote',
    );
    products.replaceManyWithIds(
      [remoteRow('products', 'sku-1', { category: 'garden' })],
      'remote',
    );

    expect(products.count(null)).toBe(1);
    expect(
      products.find({ category: 'kitchen' }),
      'the stale index entry must be cleaned up, not left dangling',
    ).toHaveLength(0);
    expect(products.find({ category: 'garden' })).toHaveLength(1);
  });

  maybe()('deletes by remote key, and the deletion does not leak outward', () => {
    // A delta refresh reports the origin's deleted ids; we map them through
    // deriveDocId to reach the local rows.
    const db = binding!.TalaDbNode.openInMemory();
    const products = db.collection('products');

    products.replaceManyWithIds(
      [
        remoteRow('products', 'sku-1', { name: 'Mug' }),
        remoteRow('products', 'sku-2', { name: 'Pan' }),
      ],
      'remote',
    );
    const removed = products.deleteManyWithIds([deriveDocId('products', 'sku-1')], 'remote');

    expect(removed).toBe(1);
    expect(products.count(null)).toBe(1);

    // No tombstone, so nothing to push: the origin already knows it deleted this.
    const changeset = JSON.parse(db.exportChanges(0, ['products']));
    expect(changeset).toHaveLength(0);
  });

  maybe()('pages locally with aggregate once rows are hydrated', () => {
    // The payoff: with the collection covered locally, paging is a local query.
    const db = binding!.TalaDbNode.openInMemory();
    const products = db.collection('products');

    products.replaceManyWithIds(
      Array.from({ length: 250 }, (_, i) =>
        remoteRow('products', `sku-${i}`, { name: `p${i}`, price: i }),
      ),
      'remote',
    );

    const page2 = products.aggregate([
      { $sort: { price: 1 } },
      { $skip: 100 },
      { $limit: 100 },
    ]);

    expect(page2).toHaveLength(100);
    expect(page2[0]!.price).toBe(100);
    expect(page2[99]!.price).toBe(199);
  });
});
