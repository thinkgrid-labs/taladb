/**
 * Unit tests for useQueries — parallel scoped queries, index-aligned results.
 *
 * Behaviours under test:
 *   - one replication + live query per entry, in parallel
 *   - results are index-aligned with the input
 *   - one-way data flow per entry (a pull that writes local re-renders that slot)
 *   - a local-only entry alongside a networked one
 *   - a networked entry with no endpoint throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TalaDBProvider } from '../../src/context'
import { ReplicationProvider, type ReplicationConfig } from '../../src/replication/config'
import { useQueries } from '../../src/useQueries'
import { __resetInflight, setSleep } from '../../src/replication/engine'
import { createSyncMockDB } from '../helpers/mockSyncDB'
import type { TalaDB } from 'taladb'

beforeEach(() => {
  __resetInflight()
  setSleep(async () => {})
})

const noopFetch = vi.fn() as unknown as typeof fetch

function makeWrapper(db: TalaDB, providerProps: Partial<ReplicationConfig> = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TalaDBProvider db={db}>
        <ReplicationProvider endpoint="/api/sync" fetch={noopFetch} {...providerProps}>
          {children}
        </ReplicationProvider>
      </TalaDBProvider>
    )
  }
}

describe('useQueries', () => {
  it('pulls each collection in parallel and returns index-aligned results', async () => {
    const { db, sync } = createSyncMockDB()
    const { result } = renderHook(
      () => useQueries([{ collection: 'orders' }, { collection: 'products' }]),
      { wrapper: makeWrapper(db) },
    )
    expect(result.current).toHaveLength(2)
    await waitFor(() => {
      const collections = sync.mock.calls.map((c) => c[1].collections?.[0])
      expect(collections).toContain('orders')
      expect(collections).toContain('products')
    })
  })

  it('re-renders each slot from the data its own pull writes', async () => {
    const { db, sync, handle } = createSyncMockDB()
    sync.mockImplementation(async (_a, options) => {
      const name = options.collections![0]
      handle(name).push([{ _id: '1', from: name }])
      return { pushed: 0, pulled: 1, cursor: 0 }
    })
    const { result } = renderHook(
      () => useQueries([{ collection: 'orders' }, { collection: 'products' }]),
      { wrapper: makeWrapper(db) },
    )
    await waitFor(() => {
      expect(result.current[0].data).toEqual([{ _id: '1', from: 'orders' }])
      expect(result.current[1].data).toEqual([{ _id: '1', from: 'products' }])
    })
  })

  it('supports a local-only entry beside a networked one', async () => {
    const { db, sync } = createSyncMockDB()
    renderHook(
      () =>
        useQueries([
          { collection: 'orders' },
          { collection: 'cache', source: 'local-only' },
        ]),
      { wrapper: makeWrapper(db) },
    )
    await waitFor(() => expect(sync).toHaveBeenCalled())
    const collections = sync.mock.calls.map((c) => c[1].collections?.[0])
    expect(collections).toContain('orders')
    expect(collections).not.toContain('cache')
  })

  it('throws when a networked entry has no endpoint', () => {
    const { db } = createSyncMockDB()
    const onlyDb = ({ children }: { children: ReactNode }) => (
      <TalaDBProvider db={db}>{children}</TalaDBProvider>
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      renderHook(() => useQueries([{ collection: 'orders' }]), { wrapper: onlyDb }),
    ).toThrow(/endpoint/)
    spy.mockRestore()
  })
})
