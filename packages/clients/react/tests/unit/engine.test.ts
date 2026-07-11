/**
 * Unit tests for the scoped-replication engine (no React).
 *
 * Covers the invariants the hooks depend on:
 *   - a pass is scoped to one collection, with the right direction + target
 *   - concurrent identical passes are de-duplicated into one db.sync
 *   - different directions are not de-duplicated
 *   - auth is resolved at send time (every pass), not cached
 *   - replicateWithRetry retries with bounded backoff, then throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncAdapter, SyncOptions, SyncResult, TalaDB } from 'taladb'
import {
  replicate,
  replicateWithRetry,
  buildAdapter,
  replicationTarget,
  setSleep,
  __resetInflight,
  type ResolvedReplicationConfig,
} from '../../src/replication/engine'

type SyncImpl = (adapter: SyncAdapter, options: SyncOptions) => Promise<SyncResult>

function mockDb(impl?: SyncImpl) {
  const sync = vi.fn(impl ?? (async () => ({ pushed: 0, pulled: 0, cursor: 0 })))
  return { db: { sync } as unknown as TalaDB, sync }
}

const baseConfig: ResolvedReplicationConfig = {
  endpoint: '/api/sync',
  fetch: vi.fn() as unknown as typeof fetch,
}

beforeEach(() => {
  __resetInflight()
  setSleep(async () => {}) // run retry backoffs instantly
})

describe('replicate', () => {
  it('scopes db.sync to the collection with direction and endpoint target', async () => {
    const { db, sync } = mockDb()
    await replicate(db, baseConfig, 'products', 'pull')
    expect(sync).toHaveBeenCalledTimes(1)
    const options = sync.mock.calls[0][1]
    expect(options).toMatchObject({
      collections: ['products'],
      direction: 'pull',
      target: replicationTarget('/api/sync', 'products'),
    })
  })

  it('de-duplicates concurrent identical passes into one db.sync', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { db, sync } = mockDb(async () => {
      await gate
      return { pushed: 0, pulled: 0, cursor: 0 }
    })
    const p1 = replicate(db, baseConfig, 'products', 'pull')
    const p2 = replicate(db, baseConfig, 'products', 'pull')
    release()
    await Promise.all([p1, p2])
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('does not de-duplicate different directions', async () => {
    const { db, sync } = mockDb()
    await Promise.all([
      replicate(db, baseConfig, 'products', 'pull'),
      replicate(db, baseConfig, 'products', 'push'),
    ])
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight entry so a later pass runs again', async () => {
    const { db, sync } = mockDb()
    await replicate(db, baseConfig, 'products', 'pull')
    await replicate(db, baseConfig, 'products', 'pull')
    expect(sync).toHaveBeenCalledTimes(2)
  })
})

describe('send-time auth', () => {
  it('buildAdapter resolves getAuth', async () => {
    const getAuth = vi.fn(async () => ({ Authorization: 'Bearer t1' }))
    await buildAdapter({ ...baseConfig, getAuth })
    expect(getAuth).toHaveBeenCalledTimes(1)
  })

  it('resolves auth on every pass, not once', async () => {
    const getAuth = vi.fn(async () => ({ Authorization: 'Bearer t' }))
    const { db } = mockDb()
    await replicate(db, { ...baseConfig, getAuth }, 'c', 'pull')
    __resetInflight()
    await replicate(db, { ...baseConfig, getAuth }, 'c', 'pull')
    expect(getAuth).toHaveBeenCalledTimes(2)
  })
})

describe('replicateWithRetry', () => {
  it('retries and then succeeds', async () => {
    let n = 0
    const { db, sync } = mockDb(async () => {
      n++
      if (n < 3) throw new Error('net')
      return { pushed: 0, pulled: 0, cursor: 0 }
    })
    await replicateWithRetry(db, baseConfig, 'c', 'push')
    expect(sync).toHaveBeenCalledTimes(3)
  })

  it('throws the last error after exhausting retries (1 + 3 backoffs)', async () => {
    const { db, sync } = mockDb(async () => {
      throw new Error('down')
    })
    await expect(replicateWithRetry(db, baseConfig, 'c', 'push')).rejects.toThrow('down')
    expect(sync).toHaveBeenCalledTimes(4)
  })
})
