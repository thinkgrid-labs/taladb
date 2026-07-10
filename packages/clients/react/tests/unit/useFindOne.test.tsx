/**
 * Unit tests for useFindOne.
 *
 * useFindOne behaves like useFind but returns the first matching document
 * (or null) rather than an array. The same subscription and cleanup
 * semantics apply.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useFindOne } from '../../src/useFindOne'
import { createMockCollection } from '../helpers/mockCollection'

interface User {
  _id?: string
  name: string
  role: 'admin' | 'member'
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useFindOne — initial state', () => {
  it('returns loading:true and data:null before the first callback', () => {
    const { collection } = createMockCollection<User>()
    const { result } = renderHook(() => useFindOne(collection, {}))
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeNull()
  })

  it('loading becomes false after the first callback', async () => {
    const { collection } = createMockCollection<User>()
    const { result } = renderHook(() => useFindOne(collection, {}))
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('data is null when the collection is empty', async () => {
    const { collection } = createMockCollection<User>()
    const { result } = renderHook(() => useFindOne(collection, {}))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBeNull()
  })

  it('data is the first document when collection has entries', async () => {
    const docs: User[] = [
      { _id: '1', name: 'Alice', role: 'admin' },
      { _id: '2', name: 'Bob', role: 'member' },
    ]
    const { collection } = createMockCollection<User>(docs)
    const { result } = renderHook(() => useFindOne(collection, {}))
    await waitFor(() => expect(result.current.data).not.toBeNull())
    // Returns only the first document, not the array
    expect(result.current.data).toEqual(docs[0])
  })
})

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

describe('useFindOne — live updates', () => {
  it('updates data when subscription fires a new first document', async () => {
    const { collection, push } = createMockCollection<User>()
    const { result } = renderHook(() => useFindOne(collection, {}))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBeNull()

    const user: User = { _id: '1', name: 'Alice', role: 'admin' }
    act(() => push([user]))
    await waitFor(() => expect(result.current.data).toEqual(user))
  })

  it('returns null when subscription fires an empty array', async () => {
    const initial: User[] = [{ _id: '1', name: 'Alice', role: 'admin' }]
    const { collection, push } = createMockCollection<User>(initial)
    const { result } = renderHook(() => useFindOne(collection, {}))
    await waitFor(() => expect(result.current.data).not.toBeNull())

    act(() => push([]))
    await waitFor(() => expect(result.current.data).toBeNull())
  })

  it('always reflects the first element when multiple docs are pushed', async () => {
    const { collection, push } = createMockCollection<User>()
    const { result } = renderHook(() => useFindOne(collection, {}))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const docs: User[] = [
      { _id: '1', name: 'Alice', role: 'admin' },
      { _id: '2', name: 'Bob', role: 'member' },
      { _id: '3', name: 'Carol', role: 'member' },
    ]
    act(() => push(docs))
    await waitFor(() => expect(result.current.data?.name).toBe('Alice'))
    expect(result.current.data?._id).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// Filter and re-subscription
// ---------------------------------------------------------------------------

describe('useFindOne — filter handling', () => {
  it('passes the filter to collection.subscribe', async () => {
    const { collection, lastFilter } = createMockCollection<User>()
    renderHook(() => useFindOne(collection, { role: 'admin' }))
    await waitFor(() => expect(lastFilter()).toEqual({ role: 'admin' }))
  })

  it('re-subscribes when the filter changes', async () => {
    const { collection, subscribeCount } = createMockCollection<User>()
    const { rerender } = renderHook(
      ({ role }: { role: User['role'] }) => useFindOne(collection, { role }),
      { initialProps: { role: 'admin' as User['role'] } },
    )
    await waitFor(() => expect(subscribeCount()).toBe(1))
    rerender({ role: 'member' })
    await waitFor(() => expect(subscribeCount()).toBe(2))
  })

  it('resets to loading:true when filter changes', async () => {
    const { collection } = createMockCollection<User>([
      { _id: '1', name: 'Alice', role: 'admin' },
    ])
    const { result, rerender } = renderHook(
      ({ role }: { role: User['role'] }) => useFindOne(collection, { role }),
      { initialProps: { role: 'admin' as User['role'] } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ role: 'member' })
    expect(result.current.loading).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('useFindOne — cleanup', () => {
  it('calls unsubscribe when the component unmounts', async () => {
    const { collection, unsubscribeCount } = createMockCollection<User>()
    const { unmount } = renderHook(() => useFindOne(collection, {}))
    await waitFor(() => expect(unsubscribeCount()).toBe(0))
    unmount()
    expect(unsubscribeCount()).toBe(1)
  })

  it('unsubscribes from old filter when filter changes', async () => {
    const { collection, unsubscribeCount } = createMockCollection<User>()
    const { rerender } = renderHook(
      ({ role }: { role: User['role'] }) => useFindOne(collection, { role }),
      { initialProps: { role: 'admin' as User['role'] } },
    )
    await waitFor(() => expect(unsubscribeCount()).toBe(0))
    rerender({ role: 'member' })
    await waitFor(() => expect(unsubscribeCount()).toBe(1))
  })
})
