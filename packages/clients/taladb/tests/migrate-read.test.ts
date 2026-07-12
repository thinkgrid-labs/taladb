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

  it('does not rewrite when only nested key order differs', async () => {
    // The migration rebuilds `address` with the same values in a different key
    // order. A JSON.stringify comparison would see a difference and rewrite the
    // document on every single read; a structural compare correctly sees none.
    const stored = { _id: 'u1', _v: 1, address: { street: 'A', city: 'Manila' } } as UserDoc;
    const { col, updateOne } = persistStub([stored]);
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: (d) => ({
        ...d,
        address: { city: 'Manila', street: 'A' },
      }),
      persistMigrations: true,
    });
    await wrapped.find();
    const [, update] = updateOne.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(update.$set).toEqual({ _v: 2 }); // only the version bump, not `address`
  });
});

// ---------------------------------------------------------------------------
// `_v` stamping on insert
// ---------------------------------------------------------------------------
// Without this, a locally-inserted document reads back with no `_v`, counts as
// version 0, and gets fed through migrateDocument as if it were legacy data —
// corrupting brand-new documents written in the current shape.

describe('_v stamping on insert', () => {
  function insertStub() {
    const inserted: UserDoc[] = [];
    const base = stub([]);
    const col = {
      ...base,
      insert: async (doc: UserDoc) => { inserted.push(doc); return 'id'; },
      insertMany: async (docs: UserDoc[]) => { inserted.push(...docs); return ['id']; },
    } as unknown as Collection<UserDoc>;
    return { col, inserted };
  }

  it('stamps the current syncSchema.version on insert and insertMany', async () => {
    const { col, inserted } = insertStub();
    const wrapped = applySchema(col, { syncSchema: { version: 2 } });
    await wrapped.insert({ fullName: 'Ada Lovelace' });
    await wrapped.insertMany([{ fullName: 'Alan Turing' }]);
    expect(inserted.map((d) => d._v)).toEqual([2, 2]);
  });

  it('preserves an explicitly supplied _v', async () => {
    const { col, inserted } = insertStub();
    const wrapped = applySchema(col, { syncSchema: { version: 3 } });
    await wrapped.insert({ fullName: 'x', _v: 1 } as UserDoc);
    expect(inserted[0]._v).toBe(1);
  });

  it('does not stamp when no syncSchema.version is declared', async () => {
    const { col, inserted } = insertStub();
    const wrapped = applySchema(col, { syncSchema: { required: ['fullName'] } });
    await wrapped.insert({ fullName: 'x' });
    expect(inserted[0]._v).toBeUndefined();
  });

  it('does not run migrateDocument over a freshly-inserted document', async () => {
    // The regression: insert a current-shape doc, read it back, and the v1→v2
    // migration would run on it — producing `fullName: "undefined undefined"`.
    const inserted: UserDoc[] = [];
    const base = stub([]);
    const col = {
      ...base,
      insert: async (doc: UserDoc) => { inserted.push(doc); return 'id'; },
      find: async () => [...inserted],
    } as unknown as Collection<UserDoc>;

    const seen: number[] = [];
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: (d, from) => {
        seen.push(from);
        return { ...d, fullName: `${d.first} ${d.last}` };
      },
    });
    await wrapped.insert({ fullName: 'Ada Lovelace' });
    const [doc] = await wrapped.find();

    expect(seen).toEqual([]); // migration never consulted
    expect(doc.fullName).toBe('Ada Lovelace'); // not "undefined undefined"
  });
});

// ---------------------------------------------------------------------------
// Live queries (subscribe) — the path every @taladb/react hook reads through
// ---------------------------------------------------------------------------

describe('subscribe (live queries)', () => {
  /** A stub whose `subscribe` hands us the engine-side callback to fire. */
  function subscribeStub(docs: UserDoc[]) {
    let emit: ((docs: UserDoc[]) => void) | null = null;
    const updateOne = vi.fn(async () => true);
    const base = stub(docs);
    const col = {
      ...base,
      updateOne,
      subscribe: (_f: unknown, cb: (d: UserDoc[]) => void) => { emit = cb; return () => {}; },
    } as unknown as Collection<UserDoc>;
    return { col, updateOne, fire: (d: UserDoc[]) => emit!(d) };
  }

  it('delivers migrated documents to the subscriber', async () => {
    const { col, fire } = subscribeStub([]);
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
    });
    const received: UserDoc[][] = [];
    wrapped.subscribe({}, (docs) => received.push(docs));
    fire([{ _id: 'u1', first: 'Ada', last: 'Lovelace' }]);

    expect(received[0][0].fullName).toBe('Ada Lovelace');
    expect(received[0][0]._v).toBe(2);
  });

  it('persists the upgraded shape when persistMigrations is on', async () => {
    const { col, updateOne, fire } = subscribeStub([]);
    const wrapped = applySchema(col, {
      syncSchema: { version: 2 },
      migrateDocument: migrate,
      persistMigrations: true,
    });
    wrapped.subscribe({}, () => {});
    fire([{ _id: 'u1', first: 'Ada', last: 'Lovelace' }]);
    await vi.waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
  });

  it('passes an un-migratable document to onError rather than throwing', async () => {
    const { col, fire } = subscribeStub([]);
    const wrapped = applySchema(col, {
      schema: { parse: () => { throw new Error('bad shape'); } },
      validateOnRead: true,
      syncSchema: { version: 2 },
      migrateDocument: migrate,
    });
    const errors: unknown[] = [];
    wrapped.subscribe({}, () => {}, (e) => errors.push(e));
    fire([{ _id: 'u1', first: 'Ada' }]);
    expect(errors).toHaveLength(1);
  });

  it('passes documents through untouched when no read transform applies', () => {
    // Only `_v` stamping is active here — reads need no transform, so the
    // subscriber sees the engine's own document objects, not copies.
    const { col, fire } = subscribeStub([]);
    const wrapped = applySchema(col, { syncSchema: { version: 2 } });
    const doc: UserDoc = { _id: 'u1', fullName: 'Ada' };
    const received: UserDoc[][] = [];
    wrapped.subscribe({}, (docs) => received.push(docs));
    fire([doc]);
    expect(received[0][0]).toBe(doc);
  });
});

// ---------------------------------------------------------------------------
// syncSchema validation
// ---------------------------------------------------------------------------

describe('syncSchema validation', () => {
  it('rejects renames without a version', () => {
    // The migration step only runs for documents below `version`; with no
    // version the rename never fires, and `required` then quarantines every
    // document it was meant to fix.
    expect(() =>
      applySchema(stub([]), { syncSchema: { required: ['fullName'], renames: { name: 'fullName' } } }),
    ).toThrow('require syncSchema.version >= 1');
  });

  it('rejects defaults without a version', () => {
    expect(() =>
      applySchema(stub([]), { syncSchema: { defaults: { age: 0 } } }),
    ).toThrow('require syncSchema.version >= 1');
  });

  it('accepts renames when a version is declared', () => {
    expect(() =>
      applySchema(stub([]), { syncSchema: { version: 2, renames: { name: 'fullName' } } }),
    ).not.toThrow();
  });
});
