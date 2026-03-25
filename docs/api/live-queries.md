# Live Queries

Live queries let you subscribe to a filtered view of a collection and receive a fresh snapshot of matching documents after every write — without polling.

## How it works

Internally, each `Collection` shares a `WatchRegistry` protected by a `Mutex`. On every successful write transaction, the collection calls `WatchRegistry::notify`, which sends a lightweight `WriteEvent` to every registered subscriber via an MPSC channel.

Each `WatchHandle` holds the receiving end of one such channel. When `next()` is called, it:

1. Blocks until a `WriteEvent` arrives
2. Drains any additional coalesced events (rapid consecutive writes appear as a single snapshot)
3. Re-runs the original query against the current database state
4. Returns the result

The query is always re-executed at receive time, so the snapshot is always fresh regardless of how many writes were coalesced.

## Creating a watch handle

```ts
const handle = users.watch({ role: 'admin' })
```

The filter is evaluated using the same query planner as `find`. If the `role` field has an index, the watch query uses it.

## `next()` — blocking

Blocks until the next write to the collection, then returns the current matching documents.

```ts
const snapshot = await handle.next()
// snapshot is T[] — all documents matching the filter right now
```

`next()` always returns a result — it never returns `null`. It throws only if the underlying watch channel has been closed (which happens if the collection or database is dropped).

## `tryNext()` — non-blocking

Returns the current snapshot if a write has occurred since the last call, or `null` if nothing has changed.

```ts
const snapshot = await handle.tryNext()
if (snapshot !== null) {
  console.log('Updated:', snapshot)
}
```

## Async iteration

`WatchHandle` implements the async iterator protocol:

```ts
for await (const snapshot of handle) {
  console.log('Collection changed:', snapshot)
}
```

The loop runs indefinitely, yielding a new snapshot after each write. To stop it, break out of the loop or close the database.

## Multiple handles on the same collection

Each call to `watch` creates an independent handle with its own channel and filter:

```ts
const admins = users.watch({ role: 'admin' })
const unverified = users.watch({ verified: false })

// Each handle runs its own query independently
admins.next().then(console.log)
unverified.next().then(console.log)
```

## React integration

```tsx
import { useEffect, useRef, useState } from 'react'
import type { Collection, Document, Filter } from 'taladb'

export function useWatch<T extends Document>(
  collection: Collection<T>,
  filter: Filter<T> = {},
) {
  const [docs, setDocs] = useState<T[]>([])
  const cancelRef = useRef(false)

  useEffect(() => {
    cancelRef.current = false
    const handle = collection.watch(filter)

    // Seed with the current state
    collection.find(filter).then(setDocs)

    async function loop() {
      while (!cancelRef.current) {
        try {
          const snapshot = await handle.next()
          if (!cancelRef.current) setDocs(snapshot)
        } catch {
          break
        }
      }
    }

    loop()

    return () => {
      cancelRef.current = true
    }
  }, [collection])

  return docs
}
```

```tsx
function AdminList() {
  const admins = useWatch(db.collection<User>('users'), { role: 'admin' })

  return (
    <ul>
      {admins.map((u) => <li key={u._id}>{u.name}</li>)}
    </ul>
  )
}
```

## React Native integration

The same `useWatch` hook works in React Native — the live query runs on the JS thread using the JSI HostObject's subscribe mechanism.

```tsx
const notes = useWatch(db.collection<Note>('notes'))
```

## Backpressure and coalescing

The internal MPSC channel has a capacity of 64 events. If writes arrive faster than `next()` is called, older events are dropped and replaced by the latest. Because the handle always re-runs the query at receive time, no documents are ever silently skipped — the worst case is that two rapid writes coalesce into one snapshot update.

This makes live queries suitable for UI updates where you want the latest state, not a log of every individual change.

## Closing

Watch handles are closed automatically when the collection or database goes out of scope. In long-running processes, ensure your watch loops exit cleanly by breaking the loop before closing the database.
