/**
 * TalaDB — Browser (WASM) comprehensive example
 *
 * Demonstrates: CRUD, indexes, bulk ops, all filter operators,
 * all update operators, migrations, live queries, snapshots.
 *
 * Prerequisites:
 *   pnpm --filter @taladb/web build
 *   pnpm --filter taladb-example-web dev
 */
import { openDB } from 'taladb';
import type { Document, Filter, Update } from 'taladb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface User extends Document {
  name: string;
  email: string;
  role: string;
  score: number;
  active: boolean;
  tags: string[];
  loginCount: number;
  createdAt: number;
}

interface Product extends Document {
  name: string;
  price: number;
  category: string;
  inStock: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(label: string, value: unknown): void {
  console.log(`[${label}]`, value);
}

// ---------------------------------------------------------------------------
// Main (top-level await — requires "module": "ESNext" + Vite/bundler)
// ---------------------------------------------------------------------------

// Open DB
const db = await openDB('myapp.db');

  // =========================================================================
  // 1 — Indexes
  // =========================================================================

  const users = db.collection<User>('users');
  await users.createIndex('email');   // idempotent — safe to call multiple times
  await users.createIndex('email');
  await users.createIndex('role');
  await users.createIndex('score');
  await users.createIndex('active');

  // =========================================================================
  // 2 — Insert
  // =========================================================================

  const aliceId = await users.insert({
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
    score: 95,
    active: true,
    tags: ['rust', 'wasm'],
    loginCount: 12,
    createdAt: Date.now(),
  });
  const bobId = await users.insert({
    name: 'Bob',
    email: 'bob@example.com',
    role: 'editor',
    score: 72,
    active: true,
    tags: ['js', 'react'],
    loginCount: 4,
    createdAt: Date.now(),
  });
  await users.insert({
    name: 'Carol',
    email: 'carol@example.com',
    role: 'viewer',
    score: 58,
    active: false,
    tags: ['design'],
    loginCount: 1,
    createdAt: Date.now(),
  });

  log('Alice id', aliceId);
  log('Bob id', bobId);

  // =========================================================================
  // 3 — Bulk insert (insertMany)
  // =========================================================================

  await users.insertMany([
    { name: 'Dave',  email: 'dave@example.com',  role: 'viewer', score: 40, active: true,  tags: [],       loginCount: 0, createdAt: Date.now() },
    { name: 'Eve',   email: 'eve@example.com',   role: 'editor', score: 88, active: true,  tags: ['wasm'], loginCount: 7, createdAt: Date.now() },
    { name: 'Frank', email: 'frank@example.com', role: 'viewer', score: 30, active: false, tags: [],       loginCount: 0, createdAt: Date.now() },
  ]);

  log('Total after insertMany', await users.count());  // 6

  // =========================================================================
  // 4 — find / findOne
  // =========================================================================

  const alice = await users.findOne({ email: 'alice@example.com' });
  log('Alice', alice?.name);

  const allUsers = await users.find();
  log('All users', allUsers.map((u: User) => u.name));

  // =========================================================================
  // 5 — Range queries (index-backed)
  // =========================================================================

  const highScorers = await users.find({ score: { $gte: 80 } });
  log('score >= 80', highScorers.map((u: User) => u.name));

  const midRange = await users.find({ score: { $gt: 50, $lt: 90 } });
  log('50 < score < 90', midRange.map((u: User) => u.name));

  const lowScorers = await users.find({ score: { $lte: 40 } });
  log('score <= 40', lowScorers.map((u: User) => u.name));

  // =========================================================================
  // 6 — $in / $nin
  // =========================================================================

  const staff = await users.find({ role: { $in: ['admin', 'editor'] } });
  log('admin|editor', staff.map((u: User) => u.name));

  const nonViewers = await users.find({ role: { $nin: ['viewer'] } });
  log('not viewers', nonViewers.map((u: User) => u.name));

  // =========================================================================
  // 7 — $and / $or / $not / $ne
  // =========================================================================

  const activeEditors: Filter<User> = {
    $and: [{ role: 'editor' }, { active: true }],
  };
  const editors = await users.find(activeEditors);
  log('active editors', editors.map((u: User) => u.name));

  const adminOrHighScore = await users.find({
    $or: [{ role: 'admin' }, { score: { $gte: 85 } }],
  });
  log('admin OR score>=85', adminOrHighScore.map((u: User) => u.name));

  const notAdmin = await users.find({ role: { $ne: 'admin' } });
  log('not admin', notAdmin.map((u: User) => u.name));

  // =========================================================================
  // 8 — $exists
  // =========================================================================

  const withScore = await users.find({ score: { $exists: true } });
  log('has score field', withScore.length);

  // =========================================================================
  // 9 — Update operators
  // =========================================================================

  // $set — update fields
  const setOp: Update<User> = { $set: { score: 99, role: 'superadmin' } };
  await users.updateOne({ email: 'alice@example.com' }, setOp);
  log('Alice score after $set', (await users.findOne({ email: 'alice@example.com' }))?.score);

  // $inc — increment
  const incOp: Update<User> = { $inc: { score: 5, loginCount: 1 } };
  await users.updateOne({ email: 'bob@example.com' }, incOp);
  log('Bob score after $inc(+5)', (await users.findOne({ email: 'bob@example.com' }))?.score);

  // $unset — remove a field
  const unsetOp: Update<User> = { $unset: { active: true } };
  await users.updateOne({ email: 'carol@example.com' }, unsetOp);
  const carol = await users.findOne({ email: 'carol@example.com' });
  log('Carol active after $unset', carol?.active);  // undefined

  // $push — append to array
  const pushOp: Update<User> = { $push: { tags: 'typescript' } };
  await users.updateOne({ email: 'bob@example.com' }, pushOp);
  log('Bob tags after $push', (await users.findOne({ email: 'bob@example.com' }))?.tags);

  // $pull — remove from array
  const pullOp: Update<User> = { $pull: { tags: 'wasm' } };
  await users.updateOne({ email: 'alice@example.com' }, pullOp);
  log('Alice tags after $pull', (await users.findOne({ email: 'alice@example.com' }))?.tags);

  // updateMany — bulk update
  const promotedCount = await users.updateMany(
    { role: 'viewer' },
    { $set: { role: 'user' } },
  );
  log('Promoted viewers → user', promotedCount);

  // =========================================================================
  // 10 — Count
  // =========================================================================

  log('Total', await users.count());
  log('Active', await users.count({ active: true }));
  log('Admins', await users.count({ role: 'admin' }));

  // =========================================================================
  // 11 — Multi-collection: Products
  // =========================================================================

  const products = db.collection<Product>('products');
  await products.createIndex('category');
  await products.createIndex('price');

  await products.insertMany([
    { name: 'Widget A',  price: 9.99,  category: 'widgets', inStock: true  },
    { name: 'Widget B',  price: 19.99, category: 'widgets', inStock: false },
    { name: 'Gadget X',  price: 49.99, category: 'gadgets', inStock: true  },
    { name: 'Gadget Y',  price: 99.99, category: 'gadgets', inStock: true  },
    { name: 'Doohickey', price: 4.99,  category: 'misc',    inStock: true  },
  ]);

  const affordableWidgets = await products.find({
    $and: [{ category: 'widgets' }, { price: { $lt: 15 } }],
  });
  log('Cheap widgets', affordableWidgets.map((p: Product) => p.name));

  const inStockGadgets = await products.find({
    $and: [{ category: 'gadgets' }, { inStock: true }],
  });
  log('In-stock gadgets', inStockGadgets.map((p: Product) => p.name));

  // =========================================================================
  // 12 — Delete
  // =========================================================================

  const beforeDelete = await users.count();
  await users.deleteOne({ email: 'frank@example.com' });
  log('Deleted Frank', `${beforeDelete} → ${await users.count()}`);

  const deletedInactive = await users.deleteMany({ active: false });
  log('Bulk deleted inactive users', deletedInactive);
  log('Remaining users', await users.count());

  // =========================================================================
  // 13 — Drop index (falls back to full scan)
  // =========================================================================

  await users.dropIndex('score');
  const afterDrop = await users.find({ score: { $gte: 80 } });
  log('score>=80 after index drop (full scan)', afterDrop.length);

  // =========================================================================
  // Done
  // =========================================================================

await db.close();
console.log('✓ All examples completed successfully.');
