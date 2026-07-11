/**
 * A TalaDB mock that adds a spy-able `sync` on top of {@link createMockCollection}.
 *
 * `sync` is a `vi.fn` returning an empty {@link SyncResult} by default; override
 * it with `.mockImplementation` to simulate a pull landing data (call
 * `handle(name).push(docs)` inside the impl to exercise the one-way data flow)
 * or to simulate network failure by throwing.
 */
import { vi } from 'vitest'
import type { Collection, Document, SyncAdapter, SyncOptions, SyncResult, TalaDB } from 'taladb'
import { createMockCollection, type MockCollectionHandle } from './mockCollection'

export function createSyncMockDB() {
  const store = new Map<string, MockCollectionHandle<Document>>()

  function handle(name: string): MockCollectionHandle<Document> {
    if (!store.has(name)) store.set(name, createMockCollection<Document>())
    return store.get(name)!
  }

  const sync = vi.fn(
    async (_adapter: SyncAdapter, _options: SyncOptions): Promise<SyncResult> => ({
      pushed: 0,
      pulled: 0,
      cursor: 0,
    }),
  )

  const db = {
    collection<T extends Document>(name: string): Collection<T> {
      return handle(name).collection as unknown as Collection<T>
    },
    sync,
    exportChanges: vi.fn(async () => '[]'),
    importChanges: vi.fn(async () => 0),
    close: async () => {},
  }

  return { db: db as unknown as TalaDB, sync, handle }
}
