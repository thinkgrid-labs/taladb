---
title: Updates
description: TalaDB update operator reference — $set, $unset, $inc, $push, and $pull. Combine operators in a single call; all changes are applied atomically.
---

# Updates

An update object describes how to mutate the fields of a matched document. TalaDB uses operator-based updates rather than full document replacement, so unmentioned fields are left untouched.

## TypeScript type

```ts
type Update<T extends Document = Document> = {
  $set?:   Partial<T>
  $unset?: { [K in keyof T]?: true }
  $inc?:   { [K in keyof T]?: number }
  $push?:  { [K in keyof T]?: Value }
  $pull?:  { [K in keyof T]?: Value }
}
```

Multiple operators can be combined in a single update call. They are applied in this order: `$unset` → `$set` → `$inc` → `$push` → `$pull`.

## `$set`

Sets one or more fields to the given values. If the field does not exist it is created.

```ts
await users.updateOne(
  { email: 'alice@example.com' },
  { $set: { age: 31, updatedAt: Date.now() } },
)
```

## `$unset`

Removes one or more fields from the document. The value in the `$unset` object is ignored — use `true` by convention.

```ts
await users.updateOne(
  { _id: id },
  { $unset: { tempToken: true, resetExpiry: true } },
)
```

## `$inc`

Increments a numeric field by the given amount. Negative values decrement. If the field does not exist it is initialised to the increment value.

```ts
await posts.updateOne(
  { _id: postId },
  { $inc: { views: 1, likes: 1 } },
)

// Decrement
await items.updateOne(
  { _id: itemId },
  { $inc: { stock: -1 } },
)
```

`$inc` only works on numeric fields (`Int` or `Float` in the Rust value model). Applying it to a non-numeric field returns an error.

## `$push`

Appends a value to an array field. If the field does not exist it is initialised to a one-element array.

```ts
await users.updateOne(
  { _id: userId },
  { $push: { tags: 'verified' } },
)

await posts.updateOne(
  { _id: postId },
  { $push: { comments: { author: 'Bob', text: 'Great post!' } } },
)
```

## `$pull`

Removes the first occurrence of a value from an array field. Uses deep equality for object values.

```ts
await users.updateOne(
  { _id: userId },
  { $pull: { tags: 'trial' } },
)
```

## Combining operators

```ts
await users.updateOne(
  { email: 'alice@example.com' },
  {
    $set:   { lastSeenAt: Date.now() },
    $inc:   { loginCount: 1 },
    $unset: { resetToken: true },
    $push:  { loginHistory: { ip: '1.2.3.4', at: Date.now() } },
  },
)
```

## `updateOne` vs `updateMany`

- `updateOne` — updates the first matching document; returns `true` if a document was found
- `updateMany` — updates all matching documents; returns the count of documents updated

```ts
// Update one
const found = await users.updateOne({ _id: id }, { $set: { verified: true } })

// Update all unverified users
const count = await users.updateMany({ verified: false }, { $set: { verified: true } })
```

## Index maintenance

When an update changes a field that has a secondary index, TalaDB automatically removes the old index entry and inserts the new one within the same write transaction. Index and document are always consistent.

```ts
await users.createIndex('email')

// Old index entry removed, new one added — all atomically
await users.updateOne(
  { _id: id },
  { $set: { email: 'new@example.com' } },
)
```
