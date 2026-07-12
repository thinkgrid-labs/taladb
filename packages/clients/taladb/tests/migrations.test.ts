import { describe, it, expect, vi } from 'vitest';
import { runMigrations, type Migration } from '../src/index';
import type { TalaDB } from '../src/index';

// runMigrations is runtime-agnostic: it only needs a `db` (passed to each `up`)
// plus getVersion/setVersion accessors. These tests exercise the ordering,
// checkpoint, skip, and validation logic without any native binding — the same
// loop every platform (browser worker, React Native JSI, Node) drives.

/** A fake version store that mimics a binding's persisted counter. */
function versionStore(initial = 0) {
  let v = initial;
  return {
    get: vi.fn(async () => v),
    set: vi.fn(async (next: number) => {
      v = next;
    }),
    current: () => v,
  };
}

const db = {} as TalaDB; // migrations here don't touch the db

describe('runMigrations', () => {
  it('runs pending migrations in ascending version order', async () => {
    const ran: number[] = [];
    const store = versionStore(0);
    const migrations: Migration[] = [
      { version: 3, up: () => { ran.push(3); } },
      { version: 1, up: () => { ran.push(1); } },
      { version: 2, up: () => { ran.push(2); } },
    ];
    await runMigrations(db, store.get, store.set, migrations);
    expect(ran).toEqual([1, 2, 3]);
    expect(store.current()).toBe(3);
  });

  it('checkpoints after each migration (setVersion called per version)', async () => {
    const store = versionStore(0);
    await runMigrations(db, store.get, store.set, [
      { version: 1, up: () => {} },
      { version: 2, up: () => {} },
    ]);
    expect(store.set.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it('skips migrations at or below the stored version', async () => {
    const ran: number[] = [];
    const store = versionStore(2);
    await runMigrations(db, store.get, store.set, [
      { version: 1, up: () => ran.push(1) },
      { version: 2, up: () => ran.push(2) },
      { version: 3, up: () => ran.push(3) },
    ]);
    expect(ran).toEqual([3]); // 1 and 2 already applied
    expect(store.current()).toBe(3);
  });

  it('stops on a failing migration and does not advance past it', async () => {
    const ran: number[] = [];
    const store = versionStore(0);
    const migrations: Migration[] = [
      { version: 1, up: () => { ran.push(1); } },
      { version: 2, up: () => { ran.push(2); throw new Error('boom'); } },
      { version: 3, up: () => { ran.push(3); } },
    ];
    await expect(runMigrations(db, store.get, store.set, migrations)).rejects.toThrow('boom');
    expect(ran).toEqual([1, 2]); // v3 never ran
    expect(store.current()).toBe(1); // checkpoint stayed at last success
  });

  it('rejects a non-positive or non-integer version', async () => {
    const store = versionStore(0);
    await expect(
      runMigrations(db, store.get, store.set, [{ version: 0, up: () => {} }]),
    ).rejects.toThrow('positive integer');
    await expect(
      runMigrations(db, store.get, store.set, [{ version: 1.5, up: () => {} }]),
    ).rejects.toThrow('positive integer');
  });

  it('rejects duplicate versions', async () => {
    const store = versionStore(0);
    await expect(
      runMigrations(db, store.get, store.set, [
        { version: 1, up: () => {} },
        { version: 1, up: () => {} },
      ]),
    ).rejects.toThrow('duplicate migration version');
  });

  it('awaits async up bodies before advancing the version', async () => {
    const order: string[] = [];
    const store = versionStore(0);
    await runMigrations(db, store.get, store.set, [
      {
        version: 1,
        up: async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push('up-done');
        },
      },
    ]);
    order.push('after');
    // setVersion(1) must have been called only after up resolved.
    expect(store.set).toHaveBeenCalledWith(1);
    expect(order).toEqual(['up-done', 'after']);
  });
});
