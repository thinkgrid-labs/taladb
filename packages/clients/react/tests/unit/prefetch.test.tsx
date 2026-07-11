/**
 * Unit tests for prefetch — background first-run warming via <ReplicationProvider>.
 *
 * Behaviours under test:
 *   - warms each configured slice with a pull on mount
 *   - string shorthand and { collection } object forms both work
 *   - mode 'once' skips a slice that has already synced (cursor exists)
 *   - mode 'always' warms even a previously-synced slice
 *   - best-effort: one slice failing doesn't stop the others
 *   - no prefetch config → no background pulls
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { TalaDBProvider } from '../../src/context'
import { ReplicationProvider, setPrefetchScheduler } from '../../src/replication/config'
import { __resetInflight, setSleep } from '../../src/replication/engine'
import { createSyncMockDB } from '../helpers/mockSyncDB'

beforeEach(() => {
  __resetInflight()
  setSleep(async () => {})
  // Run prefetch synchronously instead of on idle, for deterministic tests.
  setPrefetchScheduler((fn) => {
    fn()
    return () => {}
  })
})

const noopFetch = vi.fn() as unknown as typeof fetch

function pulledCollections(sync: ReturnType<typeof createSyncMockDB>['sync']): string[] {
  return sync.mock.calls
    .filter((c) => c[1].direction === 'pull')
    .map((c) => c[1].collections?.[0] as string)
}

describe('prefetch', () => {
  it('warms each configured slice with a pull on mount', async () => {
    const { db, sync } = createSyncMockDB()
    render(
      <TalaDBProvider db={db}>
        <ReplicationProvider endpoint="/api/sync" fetch={noopFetch} prefetch={['products', 'orders']}>
          <div>app</div>
        </ReplicationProvider>
      </TalaDBProvider>,
    )
    await waitFor(() => {
      const cols = pulledCollections(sync)
      expect(cols).toContain('products')
      expect(cols).toContain('orders')
    })
  })

  it('accepts the { collection } object form', async () => {
    const { db, sync } = createSyncMockDB()
    render(
      <TalaDBProvider db={db}>
        <ReplicationProvider endpoint="/api/sync" fetch={noopFetch} prefetch={[{ collection: 'products' }]}>
          <div>app</div>
        </ReplicationProvider>
      </TalaDBProvider>,
    )
    await waitFor(() => expect(pulledCollections(sync)).toContain('products'))
  })

  it("mode 'once' skips a slice that has already synced", async () => {
    const { db, sync, handle } = createSyncMockDB()
    // Seed the cursor collection so hasSynced() reports the target as synced.
    handle('__taladb_sync').push([
      { _id: 'c', target: '/api/sync::products', pushMs: 0, pullMs: 0 },
    ])
    render(
      <TalaDBProvider db={db}>
        <ReplicationProvider endpoint="/api/sync" fetch={noopFetch} prefetch={['products']}>
          <div>app</div>
        </ReplicationProvider>
      </TalaDBProvider>,
    )
    // Give the async worker a chance to run and (not) pull.
    await new Promise((r) => setTimeout(r, 30))
    expect(pulledCollections(sync)).not.toContain('products')
  })

  it("mode 'always' warms even a previously-synced slice", async () => {
    const { db, sync, handle } = createSyncMockDB()
    handle('__taladb_sync').push([
      { _id: 'c', target: '/api/sync::products', pushMs: 0, pullMs: 0 },
    ])
    render(
      <TalaDBProvider db={db}>
        <ReplicationProvider
          endpoint="/api/sync"
          fetch={noopFetch}
          prefetch={['products']}
          prefetchMode="always"
        >
          <div>app</div>
        </ReplicationProvider>
      </TalaDBProvider>,
    )
    await waitFor(() => expect(pulledCollections(sync)).toContain('products'))
  })

  it('is best-effort: one failing slice does not stop the others', async () => {
    const { db, sync } = createSyncMockDB()
    sync.mockImplementation(async (_a, options) => {
      if (options.collections?.[0] === 'bad') throw new Error('boom')
      return { pushed: 0, pulled: 0, cursor: 0 }
    })
    render(
      <TalaDBProvider db={db}>
        <ReplicationProvider endpoint="/api/sync" fetch={noopFetch} prefetch={['bad', 'good']}>
          <div>app</div>
        </ReplicationProvider>
      </TalaDBProvider>,
    )
    await waitFor(() => {
      const cols = pulledCollections(sync)
      expect(cols).toContain('bad')
      expect(cols).toContain('good')
    })
  })

  it('does nothing without a prefetch config', async () => {
    const { db, sync } = createSyncMockDB()
    render(
      <TalaDBProvider db={db}>
        <ReplicationProvider endpoint="/api/sync" fetch={noopFetch}>
          <div>app</div>
        </ReplicationProvider>
      </TalaDBProvider>,
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(sync).not.toHaveBeenCalled()
  })
})
