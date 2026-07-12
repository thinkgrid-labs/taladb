import { describe, it, expect, vi } from 'vitest';
import { applySchema } from '../src/index';
import type { Collection, Document } from '../src/index';

// Read-time document migration (CollectionOptions.migrateDocument): a lazy,
// arbitrary-JS normalization applied to documents returned by find/findOne when
// their `_v` is below syncSchema.version. Runtime-agnostic — pure client
// transform — so it's tested here against a stub collection, no engine needed.

interface UserDoc extends Document {
  first?: string;
  last?: string;
  fullName?: string;
}

function stub(docs: UserDoc[]): Collection<UserDoc> {
  return {
    insert: async () => 'id',
    insertMany: async () => ['id'],
    find: async () => [...docs],
    findOne: async () => docs[0] ?? null,
    updateOne: async () => true,
    updateMany: async () => 0,
    deleteOne: async () => true,
    deleteMany: async () => 0,
    count: async () => docs.length,
    aggregate: async () => [],
    createIndex: async () => {},
    dropIndex: async () => {},
    createCompoundIndex: async () => {},
    dropCompoundIndex: async () => {},
    createFtsIndex: async () => {},
    dropFtsIndex: async () => {},
    listIndexes: async () => ({ btree: [], fts: [], vector: [] }),
    createVectorIndex: async () => {},
    dropVectorIndex: async () => {},
    upgradeVectorIndex: async () => {},
    findNearest: async () => [],
    subscribe: () => () => {},
  };
}

const migrate = (doc: UserDoc, from: number): UserDoc =>
  from < 2 ? { ...doc, fullName: `${doc.first ?? ''} ${doc.last ?? ''}`.trim() } : doc;

describe('read-time migrateDocument', () => {
  it('upgrades a below-version document on find and stamps _v', async () => {
    const col = applySchema(stub([{ first: 'Ada', last: 'Lovelace' }]), {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
    });
    const [doc] = await col.find();
    expect(doc.fullName).toBe('Ada Lovelace'); // computed from old shape
    expect(doc._v).toBe(2); // stamped to target
  });

  it('leaves an at-version document untouched (migrate not called)', async () => {
    let called = false;
    const col = applySchema(stub([{ _v: 2, first: 'Grace', fullName: 'Grace Hopper' }]), {
      syncSchema: { version: 2 },
      migrateDocument: (d, f) => {
        called = true;
        return migrate(d, f);
      },
    });
    const [doc] = await col.find();
    expect(called).toBe(false);
    expect(doc.fullName).toBe('Grace Hopper');
  });

  it('applies on findOne too', async () => {
    const col = applySchema(stub([{ first: 'Alan', last: 'Turing' }]), {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
    });
    const doc = await col.findOne({});
    expect(doc?.fullName).toBe('Alan Turing');
    expect(doc?._v).toBe(2);
  });

  it('treats a missing _v as version 0', async () => {
    const seen: number[] = [];
    const col = applySchema(stub([{ first: 'x' }]), {
      syncSchema: { version: 3 },
      migrateDocument: (d, from) => {
        seen.push(from);
        return d;
      },
    });
    await col.find();
    expect(seen).toEqual([0]);
  });

  it('throws when migrateDocument is set without syncSchema.version', () => {
    expect(() =>
      applySchema(stub([]), { migrateDocument: (d) => d }),
    ).toThrow('requires syncSchema.version');
  });

  it('works with no schema present (read-only migration)', async () => {
    // No Zod schema — migrateDocument alone still wraps reads.
    const col = applySchema(stub([{ first: 'a', last: 'b' }]), {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
    });
    const [doc] = await col.find();
    expect(doc.fullName).toBe('a b');
  });
});

describe('persistMigrations (persist-on-read)', () => {
  /** A stub whose `updateOne` is a spy, so we can assert the write-back diff. */
  function persistStub(docs: UserDoc[]) {
    const updateOne = vi.fn(async () => true);
    const base = stub(docs);
    return { col: { ...base, updateOne } as Collection<UserDoc>, updateOne };
  }

  it('writes the upgraded shape back via updateOne when enabled', async () => {
    const { col, updateOne } = persistStub([{ _id: 'u1', first: 'Ada', last: 'Lovelace' }]);
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
      persistMigrations: true,
    });
    const [doc] = await wrapped.find();
    expect(doc.fullName).toBe('Ada Lovelace');
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(filter).toEqual({ _id: 'u1' });
    expect(update.$set).toMatchObject({ fullName: 'Ada Lovelace', _v: 2 });
  });

  it('$unset removes fields dropped by the migration', async () => {
    // migrate v2→v3 renames `fullName` to `name` (drops fullName).
    const { col, updateOne } = persistStub([{ _id: 'u1', _v: 2, fullName: 'Ada L' } as UserDoc]);
    const wrapped = applySchema(col, {
      syncSchema: { version: 3 },
      migrateDocument: (d) => {
        const { fullName, ...rest } = d as UserDoc & { fullName?: string };
        return { ...rest, name: fullName } as UserDoc;
      },
      persistMigrations: true,
    });
    await wrapped.find();
    const [, update] = updateOne.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(update.$set).toMatchObject({ name: 'Ada L', _v: 3 });
    expect(update.$unset).toEqual({ fullName: true });
  });

  it('does not write when persistMigrations is off', async () => {
    const { col, updateOne } = persistStub([{ _id: 'u1', first: 'a', last: 'b' }]);
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
    });
    await wrapped.find();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('does not write for an already-current document', async () => {
    const { col, updateOne } = persistStub([{ _id: 'u1', _v: 2, fullName: 'x' }]);
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
      persistMigrations: true,
    });
    await wrapped.find();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('is best-effort: a failed write-back still returns the migrated value', async () => {
    const base = stub([{ _id: 'u1', first: 'Alan', last: 'Turing' }]);
    const col = { ...base, updateOne: vi.fn(async () => { throw new Error('disk full'); }) } as Collection<UserDoc>;
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
      persistMigrations: true,
    });
    const [doc] = await wrapped.find();
    expect(doc.fullName).toBe('Alan Turing'); // returned despite the write failing
  });
});
