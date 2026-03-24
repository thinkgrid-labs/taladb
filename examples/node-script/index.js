/**
 * ZeroDB Node.js example
 * Run: node index.js
 * (requires zerodb-node native module to be built first: pnpm --filter zerodb-node build)
 */
const { ZeroDBNode } = require('zerodb-node');

async function main() {
  const db = ZeroDBNode.openInMemory();
  const users = db.collection('users');

  // Create indexes
  users.createIndex('email');
  users.createIndex('age');

  // Insert
  const aliceId = users.insert({ name: 'Alice', email: 'alice@example.com', age: 30 });
  const bobId = users.insert({ name: 'Bob', email: 'bob@example.com', age: 25 });
  console.log('Inserted IDs:', aliceId, bobId);

  // Find all
  console.log('All users:', users.find(null));

  // Index-backed equality lookup
  console.log('Alice by email:', users.findOne({ email: 'alice@example.com' }));

  // Range query (uses age index)
  console.log('Age >= 28:', users.find({ age: { $gte: 28 } }));

  // $in query
  console.log('Alice or Bob:', users.find({ name: { $in: ['Alice', 'Bob'] } }));

  // Update
  users.updateOne({ email: 'alice@example.com' }, { $set: { age: 31 } });
  console.log('After update:', users.findOne({ email: 'alice@example.com' }));

  // Delete
  users.deleteOne({ name: 'Bob' });
  console.log('Total after delete:', users.count(null));
}

main();
