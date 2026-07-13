/**
 * Controllable in-memory mock for Collection<T>.
 *
 * The subscribe callback fires asynchronously (microtask) to match the real
 * poller behaviour. Tests use waitFor / act(async) to observe updates.
 */
import type { Collection, CollectionIndexInfo, Document, Filter, Update, VectorSearchResult } from 'taladb'

export interface MockCollectionHandle<T extends Document> {
  /** The Collection<T> to pass into hooks. */
  collection: Collection<T>
  /** Replace current docs and notify all active subscribers. */
  push(docs: T[]): void
  /** Emit a subscription error. */
  fail(error: unknown): void
  /** How many times subscribe() has been called. */
  subscribeCount(): number
  /** How many times the returned unsubscribe fn has been called. */
  unsubscribeCount(): number
  /** The filter passed to the most recent subscribe() call. */
  lastFilter(): Filter<T> | undefined
  /** Current docs, as the engine would hold them. */
  docs(): T[]
}

/**
 * A real (if small) `$match` / `$sort` / `$skip` / `$limit` evaluator.
 *
 * Deliberately not a stub. `useQuery`'s whole claim is that paging happens
 * *locally* once a collection is covered, so a mock that ignored the pipeline
 * would make the tests assert nothing about the thing being claimed.
 */
function runPipeline<T extends Document>(docs: T[], pipeline: unknown[]): T[] {
  const matches = (d: T, filter: Record<string, any>): boolean => {
    if (filter.$and) return (filter.$and as Record<string, any>[]).every((f) => matches(d, f))
    return Object.entries(filter).every(([k, cond]) => {
      const value = (d as Record<string, unknown>)[k]
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        return Object.entries(cond as Record<string, unknown>).every(([op, operand]) => {
          switch (op) {
            case '$lt': return (value as number) < (operand as number)
            case '$lte': return (value as number) <= (operand as number)
            case '$gt': return (value as number) > (operand as number)
            case '$gte': return (value as number) >= (operand as number)
            case '$ne': return value !== operand
            case '$in': return (operand as unknown[]).includes(value)
            default: return true
          }
        })
      }
      return value === cond
    })
  }
  let out = [...docs]
  for (const stage of pipeline as Record<string, any>[]) {
    if (stage.$match) {
      out = out.filter((d) => matches(d, stage.$match))
    }
    if (stage.$sort) {
      const entries = Object.entries(stage.$sort as Record<string, 1 | -1>)
      out = [...out].sort((a, b) => {
        for (const [field, dir] of entries) {
          const av = (a as Record<string, any>)[field]
          const bv = (b as Record<string, any>)[field]
          if (av < bv) return -1 * dir
          if (av > bv) return 1 * dir
        }
        return 0
      })
    }
    if (stage.$skip !== undefined) out = out.slice(stage.$skip as number)
    if (stage.$limit !== undefined) out = out.slice(0, stage.$limit as number)
  }
  return out
}

export function createMockCollection<T extends Document>(
  initialDocs: T[] = [],
): MockCollectionHandle<T> {
  let docs = [...initialDocs]
  let _subscribeCount = 0
  let _unsubscribeCount = 0
  let _lastFilter: Filter<T> | undefined
  const callbacks = new Set<(docs: T[]) => void>()
  const errorCallbacks = new Set<(error: unknown) => void>()
  /** Live aggregate subscribers: each re-runs its own pipeline on every write. */
  const aggCallbacks = new Set<{ pipeline: unknown[]; cb: (docs: any[]) => void }>()

  function notifyAll() {
    const snapshot = [...docs]
    for (const cb of callbacks) cb(snapshot)
    for (const { pipeline, cb } of aggCallbacks) cb(runPipeline(docs, pipeline))
  }

  const collection: Collection<T> = {
    // ---- live query ----
    subscribe(filter, callback, onError) {
      _subscribeCount++
      _lastFilter = filter as Filter<T>
      callbacks.add(callback)
      if (onError) errorCallbacks.add(onError)
      // Fire async (microtask) — mirrors the real makePoller first-tick behaviour
      const snap = [...docs]
      Promise.resolve().then(() => {
        if (callbacks.has(callback)) callback(snap)
      })
      return () => {
        _unsubscribeCount++
        callbacks.delete(callback)
        if (onError) errorCallbacks.delete(onError)
      }
    },

    // ---- mutations (used in integration tests) ----
    insert: async (doc) => {
      const id = `mock-${_subscribeCount}-${docs.length}`
      docs = [...docs, { ...doc, _id: id } as unknown as T]
      notifyAll()
      return id
    },
    insertMany: async (newDocs) => {
      const ids = newDocs.map((_, i) => `mock-${_subscribeCount}-${docs.length + i}`)
      docs = [...docs, ...newDocs.map((d, i) => ({ ...d, _id: ids[i] } as unknown as T))]
      notifyAll()
      return ids
    },
    deleteOne: async (filter) => {
      const idx = docs.findIndex((d) =>
        Object.entries(filter as Record<string, unknown>).every(
          ([k, v]) => (d as Record<string, unknown>)[k] === v,
        ),
      )
      if (idx === -1) return false
      docs = [...docs.slice(0, idx), ...docs.slice(idx + 1)]
      notifyAll()
      return true
    },
    deleteMany: async () => 0,
    find: async () => [...docs],
    findOne: async () => docs[0] ?? null,
    updateOne: async () => false,
    updateMany: async () => 0,
    count: async () => docs.length,

    // ---- replication write path ----
    // Upsert by caller-supplied `_id`: the same row fetched twice must converge
    // on one document, which is what makes the bridge a down payment on the
    // replica rather than a cache beside it.
    replaceManyWithIds: async (incoming) => {
      const byId = new Map(docs.map((d) => [d._id, d]))
      for (const doc of incoming) byId.set(doc._id, doc as T)
      docs = [...byId.values()]
      notifyAll()
      return incoming.map((d) => d._id!)
    },
    deleteManyWithIds: async (ids) => {
      const gone = new Set(ids)
      const before = docs.length
      docs = docs.filter((d) => !gone.has(d._id!))
      notifyAll()
      return before - docs.length
    },

    // ---- aggregation ----
    aggregate: async (pipeline) => runPipeline(docs, pipeline as unknown[]) as never,
    subscribeAggregate: (pipeline, callback, onError) => {
      _subscribeCount++
      const entry = { pipeline: pipeline as unknown[], cb: callback as (d: any[]) => void }
      aggCallbacks.add(entry)
      if (onError) errorCallbacks.add(onError)
      const snap = runPipeline(docs, pipeline as unknown[])
      Promise.resolve().then(() => {
        if (aggCallbacks.has(entry)) entry.cb(snap)
      })
      return () => {
        _unsubscribeCount++
        aggCallbacks.delete(entry)
        if (onError) errorCallbacks.delete(onError)
      }
    },
    createIndex: async () => {},
    dropIndex: async () => {},
    createFtsIndex: async () => {},
    dropFtsIndex: async () => {},
    createVectorIndex: async () => {},
    dropVectorIndex: async () => {},
    upgradeVectorIndex: async () => {},
    listIndexes: async (): Promise<CollectionIndexInfo> => ({ btree: [], fts: [], vector: [] }),
    findNearest: async (): Promise<VectorSearchResult<T>[]> => [],
  }

  return {
    collection,
    push(newDocs: T[]) {
      docs = newDocs
      notifyAll()
    },
    fail(error: unknown) {
      for (const callback of errorCallbacks) callback(error)
    },
    subscribeCount: () => _subscribeCount,
    unsubscribeCount: () => _unsubscribeCount,
    lastFilter: () => _lastFilter,
    docs: () => [...docs],
  }
}

/** Minimal TalaDB mock that vends MockCollections by name. */
export function createMockDB() {
  const store = new Map<string, MockCollectionHandle<Document>>()

  function getHandle<T extends Document>(name: string): MockCollectionHandle<T> {
    if (!store.has(name)) {
      store.set(name, createMockCollection<Document>())
    }
    return store.get(name) as unknown as MockCollectionHandle<T>
  }

  const db = {
    collection<T extends Document>(name: string) {
      return getHandle<T>(name).collection
    },
    close: async () => {},
  }

  return { db, getHandle }
}
