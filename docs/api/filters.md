---
title: Filters
description: TalaDB filter DSL reference — $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $and, $or, $not, and $contains for full-text search.
---

# Filters

A filter is a plain JavaScript/TypeScript object that describes which documents to match. TalaDB evaluates filters against each document's fields.

## TypeScript type

```ts
type Filter<T extends Document = Document> = {
  [K in keyof T]?: T[K] | FieldOps<T[K]>
} & {
  $and?: Filter<T>[]
  $or?:  Filter<T>[]
  $not?: Filter<T>
}
```

## Field shorthand (equality)

Providing a bare value for a field is equivalent to `{ $eq: value }`.

```ts
// These are identical:
await users.find({ name: 'Alice' })
await users.find({ name: { $eq: 'Alice' } })
```

## Comparison operators

| Operator | Meaning | Example |
|---|---|---|
| `$eq` | Equal to | `{ age: { $eq: 30 } }` |
| `$ne` | Not equal to | `{ status: { $ne: 'deleted' } }` |
| `$gt` | Greater than | `{ score: { $gt: 90 } }` |
| `$gte` | Greater than or equal | `{ age: { $gte: 18 } }` |
| `$lt` | Less than | `{ price: { $lt: 100 } }` |
| `$lte` | Less than or equal | `{ age: { $lte: 65 } }` |

```ts
// Age between 25 and 40 (inclusive)
await users.find({ age: { $gte: 25, $lte: 40 } })
```

Multiple operators on the same field are implicitly ANDed.

## Membership operators

| Operator | Meaning | Example |
|---|---|---|
| `$in` | Value is in the array | `{ role: { $in: ['admin', 'editor'] } }` |
| `$nin` | Value is not in the array | `{ tag: { $nin: ['spam', 'archive'] } }` |

```ts
const staff = await users.find({ role: { $in: ['admin', 'moderator', 'editor'] } })
const clean  = await posts.find({ tags: { $nin: ['spam', 'hidden'] } })
```

## Logical operators

### `$and`

All conditions must match. Equivalent to a regular object with multiple fields.

```ts
// These are identical:
await users.find({ age: { $gte: 18 }, active: true })
await users.find({ $and: [{ age: { $gte: 18 } }, { active: true }] })
```

Use the explicit `$and` form when you need two conditions on the same field or when mixing field conditions with logical operators.

### `$or`

At least one condition must match.

```ts
await users.find({
  $or: [{ role: 'admin' }, { role: 'superuser' }],
})
```

::: tip Index acceleration for `$or`
When every branch of an `$or` uses an equality or range filter on indexed fields, TalaDB uses an **IndexOr** plan: it runs one index range scan per branch and merges the results in memory. Otherwise it falls back to a full scan.
:::

### `$not`

The condition must not match.

```ts
await users.find({ $not: { active: false } })
```

## Existence operator

```ts
// Documents that have an `avatar` field (value may be null)
await users.find({ avatar: { $exists: true } })

// Documents without a `deletedAt` field
await users.find({ deletedAt: { $exists: false } })
```

## Full-text search (`$contains`)

Available on fields indexed with `_fts:` prefix:

```ts
await posts.createIndex('_fts:body')

// Matches documents whose `body` contains all three terms (after normalisation)
const results = await posts.find({ body: { $contains: 'rust embedded database' } })
```

Search terms are normalised (lowercased, punctuation stripped). Terms shorter than 3 characters are ignored. The result set is post-filtered to ensure all terms appear.

## Match all documents

Pass an empty filter or no filter at all:

```ts
const all = await users.find()
const all = await users.find({})
```

## Index acceleration summary

The query planner selects an index when the outermost filter (or an `$and` branch) contains one of these operators on an indexed field:

| Operator | Plan |
|---|---|
| `$eq` | `IndexEq` — point lookup |
| `$gt`, `$gte`, `$lt`, `$lte` | `IndexRange` — B-tree range scan |
| `$in` | `IndexIn` — one point lookup per value, results merged |
| `$or` (all branches indexed) | `IndexOr` — one range scan per branch, results merged |

All other filters use `FullScan` — every document is fetched and evaluated in memory.

## Filter examples

```ts
// Exact match
await users.find({ email: 'alice@example.com' })

// Range
await products.find({ price: { $gte: 10, $lte: 50 } })

// Compound
await orders.find({
  $and: [
    { status: 'shipped' },
    { createdAt: { $gte: Date.now() - 86_400_000 } },
  ],
})

// OR with multiple values
await notifications.find({
  $or: [
    { type: 'mention' },
    { type: 'reply' },
    { type: 'reaction' },
  ],
})

// NOT
await sessions.find({ $not: { expired: true } })

// Existence
await profiles.find({ bio: { $exists: true } })

// Full-text
await articles.find({ content: { $contains: 'open source rust' } })
```
