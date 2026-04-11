---
title: Collection API
description: Full reference for TalaDB's Collection interface — insert, find, findWithOptions, findOne, updateOne, updateMany, deleteOne, deleteMany, count, createIndex, createCompoundIndex, aggregate, createVectorIndex, findNearest, and watch.
---

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

Documents are returned in ULID insertion order (ascending). For sorting, pagination, or field projection, use [`findWithOptions`](#findwithoptionsfilter-options).

## `findWithOptions(filter, options)`

Returns documents matching the filter, with support for sorting, pagination, and field projection.

```ts
findWithOptions(filter: Filter<T>, options: FindOptions<T>): Promise<T[]>
```

`FindOptions<T>`:

| Property | Type | Default | Description |
|---|---|---|---|
| `sort` | `SortSpec[]` | `[]` | Sort order. Applied before `skip` and `limit`. |
| `skip` | `number` | `0` | Number of documents to skip after sorting. |
| `limit` | `number \| null` | `null` | Maximum number of documents to return. `null` returns all. |
| `fields` | `(keyof T)[] \| null` | `null` | Fields to include in results. `null` returns all fields. |

`SortSpec`:

| Property | Type | Description |
|---|---|---|
| `field` | `string` | Field name to sort on. |
| `direction` | `'asc' \| 'desc'` | Sort direction. |

**Sorting**

Multiple sort specs are applied in order — the second acts as a tiebreaker for the first, and so on.

```ts
// Newest first
const recent = await posts.findWithOptions({}, {
  sort: [{ field: 'createdAt', direction: 'desc' }],
})

// By department ascending, then salary descending within each department
const ranked = await employees.findWithOptions({}, {
  sort: [
    { field: 'department', direction: 'asc' },
    { field: 'salary',     direction: 'desc' },
  ],
})
```

**Pagination**

`skip` and `limit` are applied after sorting, making them suitable for stable cursor-style pagination when combined with a deterministic sort field.

```ts
const PAGE_SIZE = 20

// Page 1
const page1 = await posts.findWithOptions({ published: true }, {
  sort:  [{ field: 'createdAt', direction: 'desc' }],
  skip:  0,
  limit: PAGE_SIZE,
})

// Page 2
const page2 = await posts.findWithOptions({ published: true }, {
  sort:  [{ field: 'createdAt', direction: 'desc' }],
  skip:  PAGE_SIZE,
  limit: PAGE_SIZE,
})
```

**Projection**

Return only the listed fields. The `_id` field is always returned unless explicitly omitted from the list.

```ts
// Return name and email only — `secret` is excluded from the response
const names = await users.findWithOptions({}, {
  fields: ['name', 'email'],
})
```

**Combining all options**

```ts
const results = await orders.findWithOptions(
  { status: 'shipped' },
  {
    sort:   [{ field: 'shippedAt', direction: 'desc' }],
    skip:   0,
    limit:  10,
    fields: ['_id', 'customerId', 'total', 'shippedAt'],
  },
)
```

The filter is applied first (using any available index), then sort, then skip and limit, and finally projection.

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

## `createCompoundIndex(fields)`

Creates a compound B-tree index on a tuple of two or more fields. A compound index accelerates `$and` queries where every listed field is constrained with an equality (`$eq`) filter.

```ts
createCompoundIndex(fields: (keyof Omit<T, '_id'> & string)[]): Promise<void>
```

The call is **idempotent** — creating an index that already exists is a no-op. The call **backfills** all existing documents automatically.

```ts
// Speed up name lookups: { lastName: 'Smith', firstName: 'Alice' }
await people.createCompoundIndex(['lastName', 'firstName'])

// Three-field compound index
await events.createCompoundIndex(['year', 'month', 'day'])
```

**When the planner uses a compound index**

The query planner picks `CompoundIndexEq` when an `$and` filter contains an equality condition on **every** field in the compound index, in any order:

```ts
// Uses the ['lastName', 'firstName'] compound index
await people.find({
  $and: [{ lastName: 'Smith' }, { firstName: 'Alice' }],
})

// Equivalent shorthand — also uses the compound index
await people.find({ lastName: 'Smith', firstName: 'Alice' })
```

If only a subset of the indexed fields is constrained, or a non-equality operator is used, the planner falls back to a single-field index (if one exists) or a full scan.

::: tip When to use compound indexes
A compound index is most useful when you always query a fixed set of fields together with equality — for example `(lastName, firstName)` for name lookups, or `(tenantId, status)` for multi-tenant filtered lists. For range queries or sorting, a single-field index is usually the better choice.
:::

Throws `InvalidOperation` if fewer than two fields are provided.

## `dropCompoundIndex(fields)`

Removes a compound index. Queries that used it will fall back to single-field indexes or a full scan.

```ts
dropCompoundIndex(fields: (keyof Omit<T, '_id'> & string)[]): Promise<void>
```

```ts
await people.dropCompoundIndex(['lastName', 'firstName'])
```

Throws `IndexNotFound` if no compound index exists for the given field tuple.

## `createVectorIndex(field, options)`

Creates a vector index on a numeric-array field. Call once at startup — the operation is idempotent.

```ts
createVectorIndex(
  field: keyof Omit<T, '_id'> & string,
  options: VectorIndexOptions,
): Promise<void>
```

`VectorIndexOptions`:

| Property | Type | Default | Description |
|---|---|---|---|
| `dimensions` | `number` | required | Expected length of every stored vector. Enforced on insert and search. |
| `metric` | `'cosine' \| 'dot' \| 'euclidean'` | `'cosine'` | Similarity metric used by `findNearest`. |
| `indexType` | `'flat' \| 'hnsw'` | `'flat'` | Search algorithm. `'hnsw'` requires the `vector-hnsw` feature. |
| `hnswM` | `number` | `16` | HNSW links per node. Higher = better recall, more memory. Only used when `indexType: 'hnsw'`. |
| `hnswEfConstruction` | `number` | `200` | HNSW build-time quality. Higher = better graph, slower build. Must be ≥ `hnswM`. |

```ts
// Flat (brute-force) — default, exact, best for < ~10K documents
await articles.createVectorIndex('embedding', { dimensions: 384 })

// HNSW — approximate, sub-linear search, best for large collections
await articles.createVectorIndex('embedding', {
  dimensions: 384,
  metric: 'cosine',
  indexType: 'hnsw',
  hnswM: 16,              // connectivity — higher = better recall, more memory
  hnswEfConstruction: 200 // build quality — higher = better graph, slower build
})

// Dot product with HNSW
await articles.createVectorIndex('embedding', { dimensions: 1536, metric: 'dot', indexType: 'hnsw' })

// Euclidean distance (converted to similarity score)
await articles.createVectorIndex('coords', { dimensions: 2, metric: 'euclidean' })
```

**Flat vs HNSW:**

| | `flat` | `hnsw` |
|---|---|---|
| Search | Exact, O(n·d) | Approximate (~95–99% recall), O(log n · d) |
| Build | Instant | O(n log n) |
| Memory | Vectors only | Vectors + graph (~`m × 2 × n` edges) |
| Best for | < ~10K docs, or when exact results are required | > ~10K docs where query latency matters |

When `indexType: 'hnsw'` is set, the HNSW graph is built in-memory at index creation time. The flat vector table is always kept as the source of truth — use [`upgradeVectorIndex`](#upgradevectorindexfield) to rebuild the graph after bulk inserts.

Existing documents that already have a valid numeric array in `field` are backfilled automatically. Documents where `field` is absent or not a numeric array are skipped silently.

Vectors are stored in a dedicated `vec::<collection>::<field>` redb table and updated atomically on every `insert`, `updateOne`, `updateMany`, `deleteOne`, and `deleteMany`.

Throws `IndexExists` if a vector index already exists on this field.

## `dropVectorIndex(field)`

Removes a vector index and all its stored vectors. `findNearest` calls on this field will fail after dropping.

```ts
dropVectorIndex(field: keyof Omit<T, '_id'> & string): Promise<void>
```

```ts
await articles.dropVectorIndex('embedding')
```

Throws `VectorIndexNotFound` if no vector index exists on this field.

## `upgradeVectorIndex(field)`

Rebuilds the HNSW graph for a vector index from the current flat vector table. Use this after bulk inserts or when approximate-nearest-neighbor recall has degraded.

```ts
upgradeVectorIndex(field: keyof Omit<T, '_id'> & string): Promise<void>
```

```ts
// After a bulk import, rebuild the HNSW graph so findNearest uses the latest data
await articles.upgradeVectorIndex('embedding')
```

The graph is rebuilt entirely in memory — no disk I/O beyond reading the flat vector table. The flat table is never modified.

This is a no-op when:
- The index was created with `indexType: 'flat'` (no HNSW options stored)
- The `vector-hnsw` feature is disabled at compile time

You can also trigger this from the CLI: see [`upgrade-vector-index`](/guide/cli#upgrade-vector-index-rebuild-hnsw-graph) in the CLI docs.

Throws `VectorIndexNotFound` if no vector index exists on `field`.

## `findNearest(field, vector, topK, filter?)`

Returns the `topK` most similar documents to `vector` using the named vector index. Results are ordered by descending similarity score (highest first).

When the index was created with `indexType: 'hnsw'` and the HNSW graph is in memory, the search uses the approximate graph automatically. Falls back to flat (brute-force) scan when no graph is available (e.g. after `upgradeVectorIndex` has not yet been called, or when a `filter` is provided — pre-filtering always forces the flat path).

```ts
findNearest(
  field: keyof Omit<T, '_id'> & string,
  vector: number[],
  topK: number,
  filter?: Filter<T>,
): Promise<VectorSearchResult<T>[]>
```

`VectorSearchResult<T>`:

| Property | Type | Description |
|---|---|---|
| `document` | `T` | The matched document, including all fields and `_id`. |
| `score` | `number` | Similarity score — higher is more similar. Range depends on the metric. |

**Score ranges by metric:**

| Metric | Range | Notes |
|---|---|---|
| `cosine` | [-1, 1] | 1.0 = identical direction, 0 = orthogonal, -1 = opposite |
| `dot` | Unbounded | Depends on vector magnitude — use with unit-normalised vectors |
| `euclidean` | (0, 1] | 1.0 = identical, approaches 0 as distance increases |

**Basic usage:**

```ts
const query = await embed('how do I reset my password?')
const results = await articles.findNearest('embedding', query, 5)

results.forEach(({ document, score }) => {
  console.log(`${score.toFixed(3)}  ${document.title}`)
})
```

**Hybrid search — metadata filter + vector ranking:**

Pass a standard `Filter<T>` as the fourth argument. Only documents matching the filter are considered as candidates before scoring.

```ts
// Find the 5 most relevant english support articles
const results = await articles.findNearest('embedding', query, 5, {
  category: 'support',
  locale: 'en',
})
```

The filter accepts any operator supported by `find` — `$and`, `$or`, `$in`, `$gt`, `$exists`, etc.

**Errors:**

- `VectorIndexNotFound` — no vector index exists on `field`
- `VectorDimensionMismatch` — `vector.length` does not match the index's configured `dimensions`

## `aggregate(pipeline)`

Executes an aggregation pipeline against the collection. A pipeline is an ordered array of stages, each transforming the document set produced by the previous stage.

```ts
aggregate(pipeline: Stage[]): Promise<Document[]>
```

If the first stage is `$match`, TalaDB consults the query planner so that any available index accelerates the initial filtering step. All subsequent stages run in memory.

### Stages

#### `$match`

Filters the working document set. Accepts any standard [Filter](/api/filters).

```ts
{ $match: { status: 'active' } }
{ $match: { $and: [{ dept: 'eng' }, { level: { $gte: 3 } }] } }
```

When placed first in the pipeline, `$match` benefits from all index acceleration (single-field, compound, FTS). A `$match` in any later position is evaluated as a full in-memory filter.

#### `$group`

Groups documents by a key and computes per-group accumulators. The output document for each group contains `_id` (the group key value) plus one field per accumulator.

```ts
{
  $group: {
    _id: '$fieldName',   // field to group by, or null for a single group
    outputField: { $accumulator: 'sourceField' },
    ...
  }
}
```

| `_id` value | Behaviour |
|---|---|
| `'$fieldName'` | One group per distinct value of `fieldName`. Documents where the field is absent are grouped under `null`. |
| `null` | All documents form a single group (equivalent to SQL `GROUP BY NULL`). |

**Accumulators**

| Accumulator | Description | Example |
|---|---|---|
| `$sum` | Sum of numeric values | `{ total: { $sum: 'amount' } }` |
| `$avg` | Arithmetic mean of numeric values. Returns `null` if no numeric values exist. | `{ avg: { $avg: 'score' } }` |
| `$min` | Minimum value | `{ lowest: { $min: 'price' } }` |
| `$max` | Maximum value | `{ highest: { $max: 'price' } }` |
| `$count` | Number of documents in the group | `{ n: { $count: {} } }` |
| `$push` | Collect all field values into an array (duplicates kept) | `{ names: { $push: 'name' } }` |
| `$addToSet` | Collect unique field values into an array | `{ tags: { $addToSet: 'tag' } }` |
| `$first` | First value of the field in the group | `{ first: { $first: 'name' } }` |
| `$last` | Last value of the field in the group | `{ last: { $last: 'name' } }` |

`$first` and `$last` reflect the document order entering `$group`. Pair with a preceding `$sort` to make the semantics explicit.

```ts
// Sum and count per department
{
  $group: {
    _id: '$dept',
    totalSalary: { $sum: 'salary' },
    headcount:   { $count: {} },
    avgSalary:   { $avg: 'salary' },
  }
}

// Single-group totals
{
  $group: {
    _id: null,
    revenue: { $sum: 'amount' },
    maxOrder: { $max: 'amount' },
  }
}
```

#### `$sort`

Sorts the working document set. Takes an array of sort specs.

```ts
{ $sort: [{ field: 'createdAt', direction: 'desc' }] }
{ $sort: [{ field: 'dept', direction: 'asc' }, { field: 'salary', direction: 'desc' }] }
```

#### `$skip`

Skips the first N documents.

```ts
{ $skip: 10 }
```

#### `$limit`

Keeps only the first N documents.

```ts
{ $limit: 5 }
```

#### `$project`

Retains only the listed fields in each document. All other fields are removed.

```ts
{ $project: ['_id', 'name', 'email'] }
```

### Pipeline examples

**Aggregation with `$match` index acceleration**

```ts
// Count and total revenue per product, for 'eu' region orders only
const results = await orders.aggregate([
  { $match: { region: 'eu' } },          // uses index if one exists on 'region'
  {
    $group: {
      _id: '$product',
      revenue: { $sum: 'amount' },
      count:   { $count: {} },
    },
  },
  { $sort: [{ field: 'revenue', direction: 'desc' }] },
  { $limit: 10 },
])
```

**Leaderboard — top 5 users by score**

```ts
const top5 = await scores.aggregate([
  { $match: { active: true } },
  { $sort:  [{ field: 'score', direction: 'desc' }] },
  { $limit: 5 },
  { $project: ['_id', 'username', 'score'] },
])
```

**Daily revenue summary (full pipeline)**

```ts
const summary = await transactions.aggregate([
  { $match: { $and: [{ status: 'settled' }, { amount: { $gt: 0 } }] } },
  {
    $group: {
      _id: '$date',
      total:  { $sum: 'amount' },
      count:  { $count: {} },
      max:    { $max: 'amount' },
    },
  },
  { $sort:   [{ field: '_id', direction: 'asc' }] },
  { $skip:   0 },
  { $limit:  30 },
  { $project: ['_id', 'total', 'count', 'max'] },
])
```

**Unique tag collection across all posts**

```ts
const [result] = await posts.aggregate([
  { $group: { _id: null, allTags: { $addToSet: 'tag' } } },
])
console.log(result.allTags)  // deduplicated array of all tags
```

**First and last event per session**

```ts
const sessions = await events.aggregate([
  { $sort: [{ field: 'ts', direction: 'asc' }] },
  {
    $group: {
      _id:   '$sessionId',
      start: { $first: 'ts' },
      end:   { $last:  'ts' },
    },
  },
])
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
