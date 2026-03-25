/**
 * TalaDB — Node.js comprehensive example
 *
 * Demonstrates: CRUD, indexes, bulk ops, filters, updates, migrations, snapshots
 *
 * Prerequisites:
 *   pnpm --filter @taladb/node build
 *   node index.js
 */
const { TalaDBNode } = require('@taladb/node');

// ---------------------------------------------------------------------------
// Schema migration: seed roles lookup on first open
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  {
    fromVersion: 0,
    toVersion: 1,
    description: 'seed default roles',
    up(txn) {
      txn.put('meta::app', 'schema', Buffer.from('1'));
    },
  },
];

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

async function main() {
  // -------------------------------------------------------------------------
  // Open DB with migrations
  // -------------------------------------------------------------------------
  const db = TalaDBNode.openInMemory({ migrations: MIGRATIONS });

  // -------------------------------------------------------------------------
  // 1. Collection + indexes
  // -------------------------------------------------------------------------
  section('1 · Indexes');

  const users = db.collection('users');
  users.createIndex('email');   // idempotent
  users.createIndex('email');   // second call must not throw
  users.createIndex('role');
  users.createIndex('score');

  console.log('Indexes created (email, role, score)');

  // -------------------------------------------------------------------------
  // 2. Insert
  // -------------------------------------------------------------------------
  section('2 · Insert');

  const aliceId = users.insert({
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
    score: 95,
    active: true,
    tags: ['rust', 'wasm'],
    createdAt: Date.now(),
  });
  const bobId = users.insert({
    name: 'Bob',
    email: 'bob@example.com',
    role: 'editor',
    score: 72,
    active: true,
    tags: ['js', 'react'],
    createdAt: Date.now(),
  });
  users.insert({
    name: 'Carol',
    email: 'carol@example.com',
    role: 'viewer',
    score: 58,
    active: false,
    tags: ['design'],
    createdAt: Date.now(),
  });

  console.log(`Alice id: ${aliceId}`);
  console.log(`Bob id:   ${bobId}`);

  // -------------------------------------------------------------------------
  // 3. Bulk insert
  // -------------------------------------------------------------------------
  section('3 · insertMany');

  const extras = [
    { name: 'Dave',  email: 'dave@example.com',  role: 'viewer', score: 40, active: true,  tags: [] },
    { name: 'Eve',   email: 'eve@example.com',   role: 'editor', score: 88, active: true,  tags: ['wasm'] },
    { name: 'Frank', email: 'frank@example.com', role: 'viewer', score: 30, active: false, tags: [] },
  ];
  users.insertMany(extras);
  console.log(`Total documents: ${users.count(null)}`);  // 6

  // -------------------------------------------------------------------------
  // 4. Find / FindOne
  // -------------------------------------------------------------------------
  section('4 · Find & FindOne');

  const alice = users.findOne({ email: 'alice@example.com' });
  console.log('Alice:', alice?.name, '| role:', alice?.role);

  const admins = users.find({ role: 'admin' });
  console.log(`Admins (${admins.length}):`, admins.map(u => u.name));

  // -------------------------------------------------------------------------
  // 5. Range queries (index-backed)
  // -------------------------------------------------------------------------
  section('5 · Range queries');

  const highScorers = users.find({ score: { $gte: 80 } });
  console.log(`score >= 80 (${highScorers.length}):`, highScorers.map(u => u.name));

  const midRange = users.find({ score: { $gte: 50, $lte: 80 } });
  console.log(`50 <= score <= 80 (${midRange.length}):`, midRange.map(u => u.name));

  const lowScorers = users.find({ score: { $lt: 50 } });
  console.log(`score < 50 (${lowScorers.length}):`, lowScorers.map(u => u.name));

  // -------------------------------------------------------------------------
  // 6. $in query
  // -------------------------------------------------------------------------
  section('6 · $in');

  const staff = users.find({ role: { $in: ['admin', 'editor'] } });
  console.log(`admin|editor (${staff.length}):`, staff.map(u => u.name));

  // -------------------------------------------------------------------------
  // 7. $and / $or / $not
  // -------------------------------------------------------------------------
  section('7 · $and / $or / $not');

  const activeEditors = users.find({
    $and: [{ role: 'editor' }, { active: true }],
  });
  console.log(`active editors (${activeEditors.length}):`, activeEditors.map(u => u.name));

  const adminOrHighScore = users.find({
    $or: [
      { role: 'admin' },
      { score: { $gte: 85 } },
    ],
  });
  console.log(`admin OR score>=85 (${adminOrHighScore.length}):`, adminOrHighScore.map(u => u.name));

  // -------------------------------------------------------------------------
  // 8. $exists
  // -------------------------------------------------------------------------
  section('8 · $exists');

  // Insert a doc without tags
  users.insert({ name: 'Grace', email: 'grace@example.com', role: 'viewer', score: 65 });

  const withTags    = users.find({ tags: { $exists: true } });
  const withoutTags = users.find({ tags: { $exists: false } });
  console.log(`has tags: ${withTags.length}, no tags: ${withoutTags.length}`);

  // -------------------------------------------------------------------------
  // 9. Update operators
  // -------------------------------------------------------------------------
  section('9 · Update operators');

  // $set
  users.updateOne({ email: 'alice@example.com' }, { $set: { score: 98, role: 'superadmin' } });
  console.log('Alice after $set:', users.findOne({ email: 'alice@example.com' })?.score);

  // $inc
  users.updateOne({ email: 'bob@example.com' }, { $inc: { score: 5 } });
  console.log('Bob score after $inc(+5):', users.findOne({ email: 'bob@example.com' })?.score);

  // $unset
  users.updateOne({ email: 'carol@example.com' }, { $unset: ['active'] });
  const carol = users.findOne({ email: 'carol@example.com' });
  console.log('Carol active after $unset:', carol?.active);  // undefined

  // $push
  users.updateOne({ email: 'bob@example.com' }, { $push: { tags: 'typescript' } });
  console.log('Bob tags after $push:', users.findOne({ email: 'bob@example.com' })?.tags);

  // $pull
  users.updateOne({ email: 'alice@example.com' }, { $pull: { tags: 'wasm' } });
  console.log('Alice tags after $pull:', users.findOne({ email: 'alice@example.com' })?.tags);

  // updateMany
  const promoted = users.updateMany({ role: 'viewer' }, { $set: { role: 'user' } });
  console.log(`Promoted ${promoted} viewers → users`);

  // -------------------------------------------------------------------------
  // 10. Count
  // -------------------------------------------------------------------------
  section('10 · Count');

  console.log('Total:', users.count(null));
  console.log('Active users:', users.count({ active: true }));

  // -------------------------------------------------------------------------
  // 11. Delete
  // -------------------------------------------------------------------------
  section('11 · Delete');

  const beforeDelete = users.count(null);
  users.deleteOne({ email: 'frank@example.com' });
  console.log(`Deleted Frank: ${beforeDelete} → ${users.count(null)}`);

  const deletedInactive = users.deleteMany({ active: false });
  console.log(`Deleted ${deletedInactive} inactive users`);
  console.log(`Remaining: ${users.count(null)}`);

  // -------------------------------------------------------------------------
  // 12. Drop index — falls back to full scan
  // -------------------------------------------------------------------------
  section('12 · Drop index');

  users.dropIndex('score');
  const afterDrop = users.find({ score: { $gte: 80 } });
  console.log(`score>=80 after index drop (full scan): ${afterDrop.length} results`);

  // -------------------------------------------------------------------------
  // 13. Snapshot export / restore
  // -------------------------------------------------------------------------
  section('13 · Snapshot');

  const snapshot = db.exportSnapshot();
  console.log(`Snapshot size: ${snapshot.length} bytes`);

  // Write more docs to original DB
  users.insert({ name: 'Post-snapshot user', email: 'z@example.com', role: 'user', score: 10 });

  const db2 = TalaDBNode.restoreFromSnapshot(snapshot);
  const snapCount = db2.collection('users').count(null);
  console.log(`Original DB count: ${users.count(null)}, Snapshot DB count: ${snapCount}`);
  // snapCount must be one less (post-snapshot insert excluded)

  console.log('\n✓ All examples completed successfully.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
