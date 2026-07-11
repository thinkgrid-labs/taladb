/**
 * Unit tests for useMutation — the write path of scoped replication.
 *
 * Behaviours under test:
 *   - writes local first (insert/update/delete), then drains via push
 *   - update translates { set } to a $set update
 *   - pending reflects an in-flight write
 *   - on drain failure: retries, surfaces error, and does NOT roll back local
 *   - auth is resolved per drain pass (send-time)
 *   - drainOnMount flushes on mount
 *   - missing endpoint throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TalaDBProvider } from '../../src/context'
import { ReplicationProvider, type ReplicationConfig } from '../../src/replication/config'
import { useMutation } from '../../src/useMutation'
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

describe('useMutation — local-first write then push', () => {
  it('inserts locally, then drains via a push pass', async () => {
    const { db, sync } = createSyncMockDB()
    const col = db.collection('orders')
    const insertSpy = vi.spyOn(col, 'insert')
    const { result } = renderHook(
      () => useMutation({ collection: 'orders', drainOnMount: false }),
      { wrapper: makeWrapper(db) },
    )
    await act(async () => {
      await result.current.mutateAsync({ type: 'insert', doc: { item: 'A' } })
    })
    expect(insertSpy).toHaveBeenCalledWith({ item: 'A' })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0][1]).toMatchObject({ collections: ['orders'], direction: 'push' })
  })

  it('translates an update to a $set', async () => {
    const { db } = createSyncMockDB()
    const col = db.collection('orders')
    const updateSpy = vi.spyOn(col, 'updateOne')
    const { result } = renderHook(
      () => useMutation({ collection: 'orders', drainOnMount: false }),
      { wrapper: makeWrapper(db) },
    )
    await act(async () => {
      await result.current.mutateAsync({
        type: 'update',
        where: { _id: '1' },
        set: { status: 'shipped' },
      })
    })
    expect(updateSpy).toHaveBeenCalledWith({ _id: '1' }, { $set: { status: 'shipped' } })
  })

  it('deletes locally then drains', async () => {
    const { db, sync } = createSyncMockDB()
    const col = db.collection('orders')
    const deleteSpy = vi.spyOn(col, 'deleteOne')
    const { result } = renderHook(
      () => useMutation({ collection: 'orders', drainOnMount: false }),
      { wrapper: makeWrapper(db) },
    )
    await act(async () => {
      await result.current.mutateAsync({ type: 'delete', where: { _id: '1' } })
    })
    expect(deleteSpy).toHaveBeenCalledWith({ _id: '1' })
    expect(sync).toHaveBeenCalledTimes(1)
  })
})

describe('useMutation — pending', () => {
  it('is true while a write is in flight, false after', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { db, sync } = createSyncMockDB()
    sync.mockImplementation(async () => {
      await gate
      return { pushed: 0, pulled: 0, cursor: 0 }
    })
    const { result } = renderHook(
      () => useMutation({ collection: 'orders', drainOnMount: false }),
      { wrapper: makeWrapper(db) },
    )
    let p!: Promise<void>
    act(() => {
      p = result.current.mutateAsync({ type: 'insert', doc: { item: 'A' } })
    })
    await waitFor(() => expect(result.current.pending).toBe(true))
    await act(async () => {
      release()
      await p
    })
    expect(result.current.pending).toBe(false)
  })
})

describe('useMutation — durable write-behind', () => {
  it('retries the drain, surfaces the error, and does not roll back the local write', async () => {
    const getAuth = vi.fn(async () => ({ Authorization: 'Bearer x' }))
    const { db, sync } = createSyncMockDB()
    sync.mockImplementation(async () => {
      throw new Error('offline')
    })
    const col = db.collection('orders')
    const insertSpy = vi.spyOn(col, 'insert')
    const { result } = renderHook(
      () => useMutation({ collection: 'orders', drainOnMount: false }),
      { wrapper: makeWrapper(db, { getAuth }) },
    )
    await act(async () => {
      await expect(
        result.current.mutateAsync({ type: 'insert', doc: { item: 'A' } }),
      ).rejects.toThrow('offline')
    })
    // Local write happened exactly once and was never undone.
    expect(insertSpy).toHaveBeenCalledTimes(1)
    // 1 attempt + 3 backoff retries.
    expect(sync).toHaveBeenCalledTimes(4)
    // Auth resolved at send time — once per pass.
    expect(getAuth).toHaveBeenCalledTimes(4)
    await waitFor(() => expect(result.current.error).toBeTruthy())
  })
})

describe('useMutation — drainOnMount', () => {
  it('flushes a push pass on mount by default', async () => {
    const { db, sync } = createSyncMockDB()
    renderHook(() => useMutation({ collection: 'orders' }), { wrapper: makeWrapper(db) })
    await waitFor(() => expect(sync).toHaveBeenCalled())
    expect(sync.mock.calls[0][1]).toMatchObject({ collections: ['orders'], direction: 'push' })
  })
})

describe('useMutation — misconfiguration', () => {
  it('throws when there is no endpoint', () => {
    const { db } = createSyncMockDB()
    const onlyDb = ({ children }: { children: ReactNode }) => (
      <TalaDBProvider db={db}>{children}</TalaDBProvider>
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      renderHook(() => useMutation({ collection: 'orders' }), { wrapper: onlyDb }),
    ).toThrow(/endpoint/)
    spy.mockRestore()
  })
})
