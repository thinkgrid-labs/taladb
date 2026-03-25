---
title: Migrations
description: Version-based schema migrations for TalaDB. Define an ordered array of up functions — TalaDB runs pending migrations atomically at database open time.
---

# Migrations

Migrations let you evolve your database schema as your application changes. TalaDB applies pending migrations at open time, in version order, inside a single atomic transaction.

## How migrations work

1. TalaDB reads the current version from a `meta::db_version` table inside the database.
2. It compares it to the highest version in your `migrations` array.
3. Any migration whose `version` is greater than the stored version is considered pending.
4. Pending migrations are sorted by `version` and executed in order.
5. After all migrations succeed, the stored version is updated.
6. If any migration throws, the entire transaction rolls back and the database is left at its previous version.

## Defining migrations

Pass a `migrations` array to `openDB`:

```ts
import { openDB } from 'taladb'

const db = await openDB('myapp.db', {
  migrations: [
    {
      version: 1,
      description: 'Create indexes',
      up: async (db) => {
        await db.collection('users').createIndex('email')
        await db.collection('users').createIndex('createdAt')
      },
    },
    {
      version: 2,
      description: 'Add role field to existing users',
      up: async (db) => {
        const users = db.collection('users')
        const all = await users.find({})
        for (const user of all) {
          if (!user.role) {
            await users.updateOne(
              { _id: user._id },
              { $set: { role: 'user' } },
            )
          }
        }
      },
    },
    {
      version: 3,
      description: 'Create posts collection index',
      up: async (db) => {
        await db.collection('posts').createIndex('authorId')
        await db.collection('posts').createIndex('publishedAt')
      },
    },
  ],
})
```

## Migration shape

```ts
interface Migration {
  version: number        // positive integer, must be unique and monotonically increasing
  description: string   // human-readable label (shown in logs)
  up: (db: ZeroDB) => Promise<void>
}
```

## Rules

**Versions must be positive integers in ascending order.** Gaps are allowed — you can go from version 1 directly to version 5. But you must never reuse or lower a version number once it has been applied.

**Never modify an existing migration.** A migration runs exactly once. If you change the `up` function after it has run on a device, that device will not re-run it. Instead, add a new migration at a higher version.

**Migrations are atomic.** All pending migrations run in a single write transaction. If migration 3 fails after 1 and 2 succeed, the entire batch rolls back. On the next open, all three are retried.

**`createIndex` is idempotent.** Calling it for an index that already exists is safe — it does nothing.

## Fresh installs

On a fresh install, the stored version is `0`. All migrations run in order on first open. This means there is no separate "initial schema" step — version 1 is your initial schema.

## Inspecting the current version

You can query the current version outside of migrations using the CLI:

```bash
taladb inspect myapp.db
```

Or in code (advanced):

```ts
import { TalaDBNode } from '@taladb/node'

const db = TalaDBNode.open('./myapp.db')
// The version is stored in the 'meta::db_version' redb table
```

## Example: adding a new collection over time

```ts
const migrations = [
  {
    version: 1,
    description: 'Initial schema',
    up: async (db) => {
      await db.collection('users').createIndex('email')
    },
  },
  {
    version: 2,
    description: 'Add posts collection',
    up: async (db) => {
      await db.collection('posts').createIndex('authorId')
      await db.collection('posts').createIndex('_fts:body')
    },
  },
  {
    version: 3,
    description: 'Normalise email to lowercase',
    up: async (db) => {
      const users = db.collection('users')
      const all = await users.find({})
      for (const user of all) {
        if (typeof user.email === 'string') {
          await users.updateOne(
            { _id: user._id },
            { $set: { email: user.email.toLowerCase() } },
          )
        }
      }
    },
  },
]
```
