# Collection API

A `Collection<T>` is returned by `db.collection<T>(name)`. All methods return Promises, even on Node.js where the underlying Rust calls are synchronous.

## `insert(doc)`

Inserts one document and returns its generated `_id`.

```ts
insert(doc: Omit<T, '_id'>): Promise<string>
```

```ts
const id = await users.insert({ name: 'Alice', age: 30 })
// id = '01HWZZQ0000000000000000000'  (ULID)
```

The `_id` field in the input is ignored — TalaDB always generates a new ULID.

## `insertMany(docs)`

Inserts multiple documents in a single write transaction and returns an array of generated IDs in insertion order.

```ts
insertMany(docs: Omit<T, '_id'>[]): Promise<string[]>
```

```ts
const ids = await users.insertMany([
  { name: 'Bob', age: 25 },
  { name: 'Carol', age: 35 },
])
```

## `find(filter?)`

Returns all documents matching the filter. If no filter is provided, returns all documents in the collection.

```ts
find(filter?: Filter<T>): Promise<T[]>
```

```ts
const all   = await users.find()
const young = await users.find({ age: { $lt: 30 } })
```

Documents are returned in ULID insertion order (ascending).

## `findOne(filter)`

Returns the first document matching the filter, or `null` if no document matches.

```ts
findOne(filter: Filter<T>): Promise<T | null>
```

```ts
const alice = await users.findOne({ email: 'alice@example.com' })
if (alice) {
  console.log(alice.name)
}
```

## `updateOne(filter, update)`

Updates the first document matching the filter. Returns `true` if a document was found and updated, `false` if no document matched.

```ts
updateOne(filter: Filter<T>, update: Update<T>): Promise<boolean>
```

```ts
const updated = await users.updateOne(
  { email: 'alice@example.com' },
  { $set: { age: 31 }, $inc: { loginCount: 1 } },
)
```

## `updateMany(filter, update)`

Updates all documents matching the filter. Returns the number of documents updated.

```ts
updateMany(filter: Filter<T>, update: Update<T>): Promise<number>
```

```ts
const count = await users.updateMany(
  { role: 'trial' },
  { $set: { role: 'user', upgradedAt: Date.now() } },
)
```

## `deleteOne(filter)`

Deletes the first document matching the filter. Returns `true` if a document was deleted, `false` if none matched.

```ts
deleteOne(filter: Filter<T>): Promise<boolean>
```

```ts
const deleted = await users.deleteOne({ _id: id })
```

## `deleteMany(filter)`

Deletes all documents matching the filter. Returns the number of documents deleted.

```ts
deleteMany(filter: Filter<T>): Promise<number>
```

```ts
const removed = await users.deleteMany({ active: false })
```

## `count(filter?)`

Returns the number of documents matching the filter. If no filter is provided, returns the total document count.

```ts
count(filter?: Filter<T>): Promise<number>
```

```ts
const total  = await users.count()
const admins = await users.count({ role: 'admin' })
```

## `createIndex(field)`

Creates a secondary B-tree index on a field. The call is idempotent — creating an existing index does nothing.

```ts
createIndex(field: keyof Omit<T, '_id'> & string): Promise<void>
```

```ts
await users.createIndex('email')
await users.createIndex('age')
```

Index creation backfills all existing documents. For large collections this may be slow — create indexes before inserting bulk data whenever possible.

### Full-text search index

Prefix the field name with `_fts:` to build an inverted token index:

```ts
await posts.createIndex('_fts:body')
const results = await posts.find({ body: { $contains: 'rust embedded' } })
```

## `dropIndex(field)`

Removes a secondary index. Queries that relied on the index will fall back to full collection scans.

```ts
dropIndex(field: keyof Omit<T, '_id'> & string): Promise<void>
```

```ts
await users.dropIndex('age')
```

## `watch(filter?)`

Returns a `WatchHandle` that yields fresh snapshots of matching documents after every write to the collection.

```ts
watch(filter?: Filter<T>): WatchHandle<T>
```

```ts
const handle = users.watch({ role: 'admin' })

// Blocking — waits for next write
const admins = await handle.next()

// Non-blocking — returns null if nothing has changed since last call
const snapshot = await handle.tryNext()

// Async iterator
for await (const snapshot of handle) {
  console.log('Admins:', snapshot)
}
```

See [Live Queries](/api/live-queries) for full details.

## `exportSnapshot()` / `restoreFromSnapshot(bytes)`

These are database-level methods, not collection-level. See [Snapshot export/import in Features](/features#snapshot-export--import).

```ts
const bytes = await db.exportSnapshot()           // Uint8Array
const db2   = await openDB('', { snapshot: bytes })
```
