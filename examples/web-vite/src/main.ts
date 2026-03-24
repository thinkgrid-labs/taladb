import { openDB } from 'zerodb';

interface User {
  _id?: string;
  name: string;
  email: string;
  age: number;
  createdAt: number;
}

async function main() {
  const db = await openDB('myapp.db');
  const users = db.collection<User>('users');

  // Create an index for faster email lookups
  await users.createIndex('email');
  await users.createIndex('age');

  // Insert a user
  const aliceId = await users.insert({
    name: 'Alice',
    email: 'alice@example.com',
    age: 30,
    createdAt: Date.now(),
  });
  console.log('Inserted Alice with id:', aliceId);

  await users.insert({
    name: 'Bob',
    email: 'bob@example.com',
    age: 25,
    createdAt: Date.now(),
  });

  // Find all users
  const all = await users.find();
  console.log('All users:', all);

  // Find with filter
  const alice = await users.findOne({ email: 'alice@example.com' });
  console.log('Found Alice:', alice);

  // Range query
  const adults = await users.find({ age: { $gte: 28 } });
  console.log('Adults (age >= 28):', adults);

  // Update
  await users.updateOne(
    { email: 'alice@example.com' },
    { $set: { age: 31 }, $inc: { loginCount: 1 } }
  );
  const updated = await users.findOne({ email: 'alice@example.com' });
  console.log('Alice after update:', updated);

  // Complex query
  const results = await users.find({
    $or: [
      { name: 'Alice' },
      { age: { $lt: 26 } },
    ],
  });
  console.log('Alice or age < 26:', results);

  // Count
  const count = await users.count();
  console.log('Total users:', count);

  // Delete
  await users.deleteOne({ name: 'Bob' });
  console.log('After deleting Bob:', await users.count());

  await db.close();
  console.log('Done.');
}

main().catch(console.error);
