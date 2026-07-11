// Regenerates app/api/sync/seed.json — the dummy origin dataset the scoped
// replication hooks pull from.
//
// The scoped-replication hooks (useQuery/useQueries/prefetch) speak TalaDB's
// sync push/pull contract, not raw REST — so a change record is not hand-written
// JSON but the engine's own export format (a ULID id + a typed `op.Upsert`).
// Rather than fake that shape, we let a real TalaDB produce it: insert the dummy
// rows, `exportChanges`, and commit the result. The route then replays this
// changeset into a memory store as the seeded origin every client pulls from.
//
//   Run:  pnpm seed     (from examples/nextjs-replication)
import { openDB } from 'taladb';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = join(here, '.seed-scratch.db');
const outPath = join(here, '..', 'app', 'api', 'sync', 'seed.json');

// ---- dummy data ---------------------------------------------------------
const categories = [
  { slug: 'kitchen', name: 'Kitchen', blurb: 'Cookware & tools' },
  { slug: 'outdoor', name: 'Outdoor', blurb: 'Trail & camp gear' },
  { slug: 'office', name: 'Office', blurb: 'Desk & workspace' },
];

const products = [
  { name: 'Cast-iron skillet', category: 'kitchen', price: 39, stock: 12 },
  { name: 'Chef knife 8"', category: 'kitchen', price: 59, stock: 7 },
  { name: 'Trail backpack 30L', category: 'outdoor', price: 89, stock: 4 },
  { name: 'Insulated bottle', category: 'outdoor', price: 24, stock: 30 },
  { name: 'Mechanical keyboard', category: 'office', price: 110, stock: 9 },
  { name: 'Desk lamp', category: 'office', price: 34, stock: 15 },
];

const orders = [
  { ref: 'A-1001', customer: 'Ava', total: 98, status: 'paid' },
  { ref: 'A-1002', customer: 'Ben', total: 24, status: 'shipped' },
  { ref: 'A-1003', customer: 'Cleo', total: 144, status: 'pending' },
];

// ---- generate -----------------------------------------------------------
await rm(dbPath, { force: true }).catch(() => {});
const db = await openDB(dbPath);
for (const c of categories) await db.collection('categories').insert(c);
for (const p of products) await db.collection('products').insert(p);
for (const o of orders) await db.collection('orders').insert(o);

const changeset = await db.exportChanges(['categories', 'products', 'orders'], 0);
const records = JSON.parse(changeset);
await writeFile(outPath, JSON.stringify(records, null, 2) + '\n');
await rm(dbPath, { force: true }).catch(() => {});
await rm(dbPath + '-wal', { force: true }).catch(() => {});
await rm(dbPath + '-shm', { force: true }).catch(() => {});

const byCollection = records.reduce((m, r) => ((m[r.collection] = (m[r.collection] ?? 0) + 1), m), {});
console.log('wrote', outPath);
console.log('records:', JSON.stringify(byCollection));
