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
  /** How many times subscribe() has been called. */
  subscribeCount(): number
  /** How many times the returned unsubscribe fn has been called. */
  unsubscribeCount(): number
  /** The filter passed to the most recent subscribe() call. */
  lastFilter(): Filter<T> | undefined
}

export function createMockCollection<T extends Document>(
  initialDocs: T[] = [],
): MockCollectionHandle<T> {
  let docs = [...initialDocs]
  let _subscribeCount = 0
  let _unsubscribeCount = 0
  let _lastFilter: Filter<T> | undefined
  const callbacks = new Set<(docs: T[]) => void>()

  function notifyAll() {
    const snapshot = [...docs]
    for (const cb of callbacks) cb(snapshot)
  }

  const collection: Collection<T> = {
    // ---- live query ----
    subscribe(filter, callback) {
      _subscribeCount++
      _lastFilter = filter as Filter<T>
      callbacks.add(callback)
      // Fire async (microtask) — mirrors the real makePoller first-tick behaviour
      const snap = [...docs]
      Promise.resolve().then(() => {
        if (callbacks.has(callback)) callback(snap)
      })
      return () => {
        _unsubscribeCount++
        callbacks.delete(callback)
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
    subscribeCount: () => _subscribeCount,
    unsubscribeCount: () => _unsubscribeCount,
    lastFilter: () => _lastFilter,
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
