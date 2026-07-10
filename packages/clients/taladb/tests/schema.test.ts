import { describe, it, expect } from 'vitest';
import { TalaDbValidationError } from '../src/index';
import type { Collection, CollectionOptions, Document } from '../src/index';

// ---------------------------------------------------------------------------
// Minimal schema stub that mimics Zod / Valibot's .parse() contract
// ---------------------------------------------------------------------------

interface UserDoc extends Document {
  name: string;
  age: number;
}

function makeSchema<T>(validator: (d: unknown) => T) {
  return { parse: validator };
}

const userSchema = makeSchema<UserDoc>((d) => {
  const doc = d as Record<string, unknown>;
  if (typeof doc.name !== 'string' || doc.name.length === 0) {
    throw new Error('name must be a non-empty string');
  }
  if (typeof doc.age !== 'number' || doc.age < 0) {
    throw new Error('age must be a non-negative number');
  }
  return doc as UserDoc;
});

// ---------------------------------------------------------------------------
// Minimal in-memory Collection stub used to test the wrapper in isolation
// ---------------------------------------------------------------------------

function makeStubCollection<T extends Document>(docs: T[]): Collection<T> {
  return {
    insert: async (doc) => {
      docs.push({ ...(doc as T), _id: 'stub-id' });
      return 'stub-id';
    },
    insertMany: async (newDocs) => {
      newDocs.forEach((d) => docs.push({ ...(d as T), _id: 'stub-id' }));
      return newDocs.map(() => 'stub-id');
    },
    find: async (_filter?) => [...docs] as T[],
    findOne: async (_filter) => (docs[0] ?? null) as T | null,
    updateOne: async () => true,
    updateMany: async () => 0,
    deleteOne: async () => true,
    deleteMany: async () => 0,
    count: async () => docs.length,
    createIndex: async () => {},
    dropIndex: async () => {},
    createFtsIndex: async () => {},
    dropFtsIndex: async () => {},
    createVectorIndex: async () => {},
    dropVectorIndex: async () => {},
    upgradeVectorIndex: async () => {},
    listIndexes: async () => ({ btree: [], fts: [], vector: [] }),
    findNearest: async () => [],
    subscribe: () => () => {},
  };
}

// Helper that creates a schema-wrapped collection directly
function wrapWithSchema<T extends Document>(
  docs: T[],
  options: CollectionOptions<T>,
): Collection<T> {
  const col = makeStubCollection<T>(docs);
  // Use the duck-typed approach — wrap manually mirroring applySchema logic
  const { schema, validateOnRead = false } = options;
  if (!schema) return col;

  function parseWrite(doc: unknown, label: string): T {
    try {
      return schema!.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, label);
    }
  }

  function parseRead(doc: unknown): T {
    try {
      return schema!.parse(doc);
    } catch (err) {
      throw new TalaDbValidationError(err, 'read');
    }
  }

  return {
    ...col,
    insert: async (doc) => {
      parseWrite(doc, 'insert');
      return col.insert(doc);
    },
    insertMany: async (docs2) => {
      docs2.forEach((d, i) => parseWrite(d, `insertMany[${i}]`));
      return col.insertMany(docs2);
    },
    find: validateOnRead
      ? async (filter?) => {
          const found = await col.find(filter);
          return found.map((d) => parseRead(d));
        }
      : col.find.bind(col),
    findOne: validateOnRead
      ? async (filter) => {
          const doc = await col.findOne(filter);
          return doc === null ? null : parseRead(doc);
        }
      : col.findOne.bind(col),
  };
}

// ---------------------------------------------------------------------------
// TalaDbValidationError
// ---------------------------------------------------------------------------

describe('TalaDbValidationError', () => {
  it('sets name to TalaDbValidationError', () => {
    const err = new TalaDbValidationError(new Error('bad'), 'insert');
    expect(err.name).toBe('TalaDbValidationError');
  });

  it('includes cause message in the error message', () => {
    const err = new TalaDbValidationError(new Error('name is required'), 'insert');
    expect(err.message).toContain('name is required');
  });

  it('includes context label in the error message', () => {
    const err = new TalaDbValidationError(new Error('oops'), 'insertMany[2]');
    expect(err.message).toContain('insertMany[2]');
  });

  it('handles non-Error cause (string)', () => {
    const err = new TalaDbValidationError('just a string');
    expect(err.message).toContain('just a string');
  });

  it('exposes the original cause', () => {
    const cause = new Error('original');
    const err = new TalaDbValidationError(cause, 'test');
    expect(err.cause).toBe(cause);
  });

  it('is instanceof Error', () => {
    const err = new TalaDbValidationError(new Error('x'));
    expect(err).toBeInstanceOf(Error);
  });

  it('is instanceof TalaDbValidationError', () => {
    const err = new TalaDbValidationError(new Error('x'));
    expect(err).toBeInstanceOf(TalaDbValidationError);
  });
});

// ---------------------------------------------------------------------------
// Schema validation on insert
// ---------------------------------------------------------------------------

describe('schema validation — insert', () => {
  it('allows a valid document through', async () => {
    const docs: UserDoc[] = [];
    const col = wrapWithSchema(docs, { schema: userSchema });
    const id = await col.insert({ name: 'Alice', age: 30 });
    expect(id).toBe('stub-id');
    expect(docs).toHaveLength(1);
  });

  it('throws TalaDbValidationError for invalid doc', async () => {
    const col = wrapWithSchema<UserDoc>([], { schema: userSchema });
    await expect(col.insert({ name: '', age: 30 })).rejects.toThrow(TalaDbValidationError);
  });

  it('throws with context label "insert"', async () => {
    const col = wrapWithSchema<UserDoc>([], { schema: userSchema });
    await expect(col.insert({ name: '', age: 30 }))
      .rejects.toThrow('(insert)');
  });

  it('does not store the document when validation fails', async () => {
    const docs: UserDoc[] = [];
    const col = wrapWithSchema(docs, { schema: userSchema });
    await col.insert({ name: 'Bob', age: 25 }).catch(() => {});
    try {
      await col.insert({ name: '', age: 25 });
    } catch { /* expected */ }
    expect(docs).toHaveLength(1); // only Bob
  });

  it('rejects negative age', async () => {
    const col = wrapWithSchema<UserDoc>([], { schema: userSchema });
    await expect(col.insert({ name: 'Carol', age: -1 })).rejects.toThrow(TalaDbValidationError);
  });
});

// ---------------------------------------------------------------------------
// Schema validation on insertMany
// ---------------------------------------------------------------------------

describe('schema validation — insertMany', () => {
  it('allows all valid documents', async () => {
    const docs: UserDoc[] = [];
    const col = wrapWithSchema(docs, { schema: userSchema });
    const ids = await col.insertMany([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
    expect(ids).toHaveLength(2);
    expect(docs).toHaveLength(2);
  });

  it('throws on the first invalid document', async () => {
    const col = wrapWithSchema<UserDoc>([], { schema: userSchema });
    await expect(col.insertMany([
      { name: 'Alice', age: 30 },
      { name: '', age: 25 },   // invalid at index 1
    ])).rejects.toThrow(TalaDbValidationError);
  });

  it('throws with indexed context label insertMany[1]', async () => {
    const col = wrapWithSchema<UserDoc>([], { schema: userSchema });
    await expect(col.insertMany([
      { name: 'Alice', age: 30 },
      { name: '', age: 25 },
    ])).rejects.toThrow('insertMany[1]');
  });

  it('does not call the underlying insertMany when validation fails', async () => {
    const docs: UserDoc[] = [];
    const col = wrapWithSchema(docs, { schema: userSchema });
    try {
      await col.insertMany([{ name: 'Alice', age: 30 }, { name: '', age: 0 }]);
    } catch { /* expected */ }
    expect(docs).toHaveLength(0);
  });

  it('inserts nothing for an empty array', async () => {
    const docs: UserDoc[] = [];
    const col = wrapWithSchema(docs, { schema: userSchema });
    const ids = await col.insertMany([]);
    expect(ids).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateOnRead
// ---------------------------------------------------------------------------

describe('schema validation — validateOnRead', () => {
  it('does not validate reads by default', async () => {
    const docs: UserDoc[] = [{ _id: '1', name: '', age: -1 }]; // would fail schema
    const col = wrapWithSchema(docs, { schema: userSchema });
    const found = await col.find();
    // Default: no validation on read — bad doc comes back as-is
    expect(found).toHaveLength(1);
  });

  it('validates docs returned by find when validateOnRead is true', async () => {
    const docs: UserDoc[] = [{ _id: '1', name: '', age: -1 }]; // invalid
    const col = wrapWithSchema(docs, { schema: userSchema, validateOnRead: true });
    await expect(col.find()).rejects.toThrow(TalaDbValidationError);
  });

  it('validates docs returned by findOne when validateOnRead is true', async () => {
    const docs: UserDoc[] = [{ _id: '1', name: '', age: -1 }];
    const col = wrapWithSchema(docs, { schema: userSchema, validateOnRead: true });
    await expect(col.findOne({ name: '' })).rejects.toThrow(TalaDbValidationError);
  });

  it('returns null from findOne without error when no doc found', async () => {
    const col = wrapWithSchema<UserDoc>([], { schema: userSchema, validateOnRead: true });
    const result = await col.findOne({ name: 'nobody' });
    expect(result).toBeNull();
  });

  it('passes valid docs through validateOnRead find', async () => {
    const docs: UserDoc[] = [{ _id: '1', name: 'Alice', age: 30 }];
    const col = wrapWithSchema(docs, { schema: userSchema, validateOnRead: true });
    const found = await col.find();
    expect(found[0].name).toBe('Alice');
  });

  it('passes valid doc through validateOnRead findOne', async () => {
    const docs: UserDoc[] = [{ _id: '1', name: 'Alice', age: 30 }];
    const col = wrapWithSchema(docs, { schema: userSchema, validateOnRead: true });
    const doc = await col.findOne({ name: 'Alice' });
    expect(doc?.name).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------
// No schema — passthrough behaviour
// ---------------------------------------------------------------------------

describe('no schema (passthrough)', () => {
  it('insert succeeds for any document when schema is undefined', async () => {
    const docs: UserDoc[] = [];
    const col = wrapWithSchema(docs, {});
    const id = await col.insert({ name: '', age: -999 });
    expect(id).toBe('stub-id');
  });

  it('find returns raw documents without parsing', async () => {
    const docs: UserDoc[] = [{ _id: '1', name: 'raw', age: 1 }];
    const col = wrapWithSchema(docs, {});
    const found = await col.find();
    expect(found[0].name).toBe('raw');
  });
});

// ---------------------------------------------------------------------------
// CollectionOptions typing — verify duck-typed schema interface
// ---------------------------------------------------------------------------

describe('CollectionOptions types (compile-time verified)', () => {
  it('accepts any object with a parse(data: unknown): T method as schema', () => {
    const zodLike = {
      parse: (d: unknown): UserDoc => {
        const doc = d as UserDoc;
        if (!doc.name) throw new Error('invalid');
        return doc;
      },
    };
    const opts: CollectionOptions<UserDoc> = { schema: zodLike };
    expect(opts.schema).toBeDefined();
  });

  it('validateOnRead defaults to false when omitted', () => {
    const opts: CollectionOptions<UserDoc> = { schema: userSchema };
    expect(opts.validateOnRead).toBeUndefined();
  });
});
