/**
 * Unit tests for useQuery — the read path of scoped replication.
 *
 * Behaviours under test:
 *   - mounts and pulls the collection over the sync-contract
 *   - one-way data flow: a pull that writes local re-renders the hook
 *   - `syncing` reflects an in-flight pass
 *   - `local-only` never touches the network and needs no endpoint
 *   - `remote-first` stays loading until the first pull resolves
 *   - refetch triggers another pull; pollMs polls
 *   - a networked source with no endpoint throws a clear error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TalaDBProvider } from '../../src/context'
import { ReplicationProvider, type ReplicationConfig } from '../../src/replication/config'
import { useQuery } from '../../src/useQuery'
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

describe('useQuery — replication on mount', () => {
  it('pulls the collection over the sync-contract on mount', async () => {
    const { db, sync } = createSyncMockDB()
    renderHook(() => useQuery({ collection: 'products' }), { wrapper: makeWrapper(db) })
    await waitFor(() => expect(sync).toHaveBeenCalled())
    expect(sync.mock.calls[0][1]).toMatchObject({ collections: ['products'], direction: 'pull' })
  })

  it('syncing settles to false after the pass', async () => {
    const { db } = createSyncMockDB()
    const { result } = renderHook(() => useQuery({ collection: 'products' }), {
      wrapper: makeWrapper(db),
    })
    await waitFor(() => expect(result.current.syncing).toBe(false))
  })
})

describe('useQuery — one-way data flow', () => {
  it('re-renders with data a pull writes into the local collection', async () => {
    const { db, sync, handle } = createSyncMockDB()
    sync.mockImplementation(async (_a, options) => {
      // Simulate importChanges writing the pulled slice into local.
      handle(options.collections![0]).push([{ _id: '1', name: 'Widget' }])
      return { pushed: 0, pulled: 1, cursor: 0 }
    })
    const { result } = renderHook(() => useQuery({ collection: 'products' }), {
      wrapper: makeWrapper(db),
    })
    await waitFor(() => expect(result.current.data).toEqual([{ _id: '1', name: 'Widget' }]))
  })
})

describe('useQuery — local-only', () => {
  it('never calls sync', async () => {
    const { db, sync } = createSyncMockDB()
    renderHook(() => useQuery({ collection: 'products', source: 'local-only' }), {
      wrapper: makeWrapper(db),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(sync).not.toHaveBeenCalled()
  })

  it('works with no ReplicationProvider (no endpoint required)', async () => {
    const { db } = createSyncMockDB()
    const onlyDb = ({ children }: { children: ReactNode }) => (
      <TalaDBProvider db={db}>{children}</TalaDBProvider>
    )
    const { result } = renderHook(
      () => useQuery({ collection: 'products', source: 'local-only' }),
      { wrapper: onlyDb },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
  })
})

describe('useQuery — remote-first', () => {
  it('stays loading until the first pull resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { db, sync } = createSyncMockDB()
    sync.mockImplementation(async () => {
      await gate
      return { pushed: 0, pulled: 0, cursor: 0 }
    })
    const { result } = renderHook(
      () => useQuery({ collection: 'products', source: 'remote-first' }),
      { wrapper: makeWrapper(db) },
    )
    await waitFor(() => expect(sync).toHaveBeenCalled())
    expect(result.current.loading).toBe(true)
    await act(async () => {
      release()
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })
})

describe('useQuery — refetch & polling', () => {
  it('refetch triggers another pull', async () => {
    const { db, sync } = createSyncMockDB()
    const { result } = renderHook(() => useQuery({ collection: 'products' }), {
      wrapper: makeWrapper(db),
    })
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.refetch()
    })
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('pollMs pulls repeatedly', async () => {
    const { db, sync } = createSyncMockDB()
    const { unmount } = renderHook(() => useQuery({ collection: 'products', pollMs: 20 }), {
      wrapper: makeWrapper(db),
    })
    await waitFor(() => expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 500 })
    unmount() // stop the interval so it doesn't tick into teardown
  })
})

describe('useQuery — misconfiguration', () => {
  it('throws when a networked source has no endpoint', () => {
    const { db } = createSyncMockDB()
    const onlyDb = ({ children }: { children: ReactNode }) => (
      <TalaDBProvider db={db}>{children}</TalaDBProvider>
    )
    // Suppress React's error-boundary console noise for the expected throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      renderHook(() => useQuery({ collection: 'products' }), { wrapper: onlyDb }),
    ).toThrow(/endpoint/)
    spy.mockRestore()
  })
})
