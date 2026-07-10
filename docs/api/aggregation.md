---
title: Aggregation
description: TalaDB aggregation pipeline reference — $match, $group, $sort, $skip, $limit, $project stages and $sum, $avg, $min, $max, $count, $push, $addToSet, $first, $last accumulators, computed inside the engine.
---

# Aggregation

`collection.aggregate(pipeline)` runs a MongoDB-style pipeline **inside the engine**, so summaries are computed in Rust over the B-tree instead of loading every document into JavaScript. A pipeline is an array of stages; each stage transforms the stream of documents produced by the previous one.

```ts
const byStatus = await orders.aggregate([
  { $match: { status: { $ne: 'draft' } } },
  { $group: { _id: '$status', total: { $sum: '$amount' }, n: { $sum: 1 } } },
  { $sort: { total: -1 } },
])
// → [{ _id: 'paid', total: 4820, n: 37 }, { _id: 'pending', total: 910, n: 6 }]
```

## TypeScript type

```ts
type AggregatePipeline<T extends Document = Document> = AggregateStage<T>[]

aggregate<R = Document>(pipeline: AggregatePipeline<T>): Promise<R[]>
```

The result type `R` is unconstrained — aggregation produces new shapes (grouped keys, computed fields), so you pass the shape you expect:

```ts
type Row = { _id: string; total: number; n: number }
const rows = await orders.aggregate<Row>([/* … */])
```

## Stages

| Stage | Purpose |
|---|---|
| `$match` | Keep only documents matching a [filter](/api/filters). Uses an index when it is the first stage. |
| `$group` | Group documents by a key and compute accumulators per group. |
| `$sort` | Order documents. `1` ascending, `-1` descending. |
| `$skip` | Drop the first *n* documents. |
| `$limit` | Keep at most *n* documents. |
| `$project` | Choose which fields to keep. Truthy value keeps a field. |

### `$match`

Takes the same [filter](/api/filters) object as `find`. When `$match` is the **first** stage, the query planner uses an index if one is available, so filtering happens before any documents are materialised.

```ts
{ $match: { status: 'active', amount: { $gte: 100 } } }
```

### `$group`

`_id` defines the grouping key. Use a field reference (`'$field'`) to group by that field, or `null` to aggregate the whole stream into a single group. Every other key is an accumulator whose value names the operation.

```ts
{ $group: {
    _id: '$customerId',
    spent: { $sum: '$amount' },
    orders: { $sum: 1 },       // count — $sum of the constant 1
    avgOrder: { $avg: '$amount' },
    firstSeen: { $min: '$createdAt' },
} }
```

The output document of each group has `_id` set to the group key plus one field per accumulator.

#### Accumulators

| Accumulator | Result |
|---|---|
| `{ $sum: '$field' }` | Sum of the field across the group |
| `{ $sum: 1 }` | Count of documents in the group |
| `{ $count: {} }` | Count of documents in the group |
| `{ $avg: '$field' }` | Mean of the field |
| `{ $min: '$field' }` | Minimum value |
| `{ $max: '$field' }` | Maximum value |
| `{ $first: '$field' }` | Field of the first document in the group |
| `{ $last: '$field' }` | Field of the last document in the group |
| `{ $push: '$field' }` | Array of the field's values, in order |
| `{ $addToSet: '$field' }` | Array of the field's distinct values |

### `$sort`, `$skip`, `$limit`

```ts
{ $sort: { total: -1, name: 1 } }   // total desc, then name asc
{ $skip: 20 }
{ $limit: 10 }
```

### `$project`

Include the listed fields (any truthy value keeps a field). `_id` is kept unless you omit it.

```ts
{ $project: { _id: 1, total: 1 } }
```

## Runtime availability

`aggregate()` is available on every runtime — Node.js, the browser (both the direct main-thread build and the OPFS worker), and React Native. The pipeline is parsed and executed inside the engine on each platform; only the transport differs (native call, WASM, worker message, or JSI).

::: tip Key ordering
`$group` accumulator fields and multi-key `$sort` are keyed from the pipeline object. Because pipelines are parsed with a `BTreeMap`, multiple keys within a single `$sort` object are applied in **alphabetical** key order, not the order you wrote them. Accumulator output names within a `$group` are unaffected — each names its own field. When multi-key sort precedence matters, prefer a single sort key whose ordering already reflects your intent.
:::
