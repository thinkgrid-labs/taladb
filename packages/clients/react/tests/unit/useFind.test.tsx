/**
 * Unit tests for useFind.
 *
 * useFind wraps collection.subscribe() with useSyncExternalStore, giving
 * components live-updating query results with a loading flag.
 *
 * Key behaviours under test:
 *   - Initial state: loading=true, data=[]
 *   - Transitions to loading=false with docs after first callback
 *   - Re-renders on subsequent subscription updates
 *   - Calls unsubscribe on unmount
 *   - Re-subscribes (once) when filter value changes
 *   - Inline filter objects with the same value do not cause extra subscriptions
 *   - Re-subscribes when the collection reference changes
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useFind } from '../../src/useFind'
import { createMockCollection } from '../helpers/mockCollection'

interface Note {
  _id?: string
  text: string
  pinned: boolean
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useFind — initial state', () => {
  it('returns loading:true and empty data before the first callback', () => {
    const { collection } = createMockCollection<Note>()
    const { result } = renderHook(() => useFind(collection))
    // Synchronously after render — callback hasn't fired yet (microtask)
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toEqual([])
  })

  it('loading becomes false after the first subscription callback', async () => {
    const { collection } = createMockCollection<Note>()
    const { result } = renderHook(() => useFind(collection))
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('data is [] when collection starts empty', async () => {
    const { collection } = createMockCollection<Note>()
    const { result } = renderHook(() => useFind(collection))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual([])
  })

  it('data reflects documents present at subscription time', async () => {
    const docs: Note[] = [
      { _id: '1', text: 'Hello', pinned: false },
      { _id: '2', text: 'World', pinned: true },
    ]
    const { collection } = createMockCollection<Note>(docs)
    const { result } = renderHook(() => useFind(collection))
    await waitFor(() => expect(result.current.data).toHaveLength(2))
    expect(result.current.data).toEqual(docs)
  })
})

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

describe('useFind — live updates', () => {
  it('re-renders when subscription fires new documents', async () => {
    const { collection, push } = createMockCollection<Note>()
    const { result } = renderHook(() => useFind(collection))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const newDocs: Note[] = [{ _id: '1', text: 'New note', pinned: false }]
    act(() => push(newDocs))

    await waitFor(() => expect(result.current.data).toEqual(newDocs))
  })

  it('re-renders on multiple successive updates', async () => {
    const { collection, push } = createMockCollection<Note>()
    const { result } = renderHook(() => useFind(collection))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => push([{ _id: '1', text: 'First', pinned: false }]))
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    act(() => push([{ _id: '1', text: 'First', pinned: false }, { _id: '2', text: 'Second', pinned: true }]))
    await waitFor(() => expect(result.current.data).toHaveLength(2))
  })
})

// ---------------------------------------------------------------------------
// Filter handling
// ---------------------------------------------------------------------------

describe('useFind — filter handling', () => {
  it('subscribes once with no filter', async () => {
    const { collection, subscribeCount } = createMockCollection<Note>()
    renderHook(() => useFind(collection))
    await waitFor(() => expect(subscribeCount()).toBe(1))
  })

  it('passes the filter to collection.subscribe', async () => {
    const { collection, lastFilter } = createMockCollection<Note>()
    const filter = { pinned: true }
    renderHook(() => useFind(collection, filter))
    await waitFor(() => expect(lastFilter()).toEqual({ pinned: true }))
  })

  it('does not re-subscribe when an inline object has the same value', async () => {
    const { collection, subscribeCount } = createMockCollection<Note>()
    // Each rerender creates a new `{ pinned: true }` object reference,
    // but the serialised key is identical — subscribe must not be called again.
    const { rerender } = renderHook(() => useFind(collection, { pinned: true }))
    await waitFor(() => expect(subscribeCount()).toBe(1))
    rerender()
    rerender()
    expect(subscribeCount()).toBe(1)
  })

  it('re-subscribes when the filter value changes', async () => {
    const { collection, subscribeCount } = createMockCollection<Note>()
    const { rerender } = renderHook(
      ({ pinned }: { pinned: boolean }) => useFind(collection, { pinned }),
      { initialProps: { pinned: true } },
    )
    await waitFor(() => expect(subscribeCount()).toBe(1))
    rerender({ pinned: false })
    await waitFor(() => expect(subscribeCount()).toBe(2))
  })

  it('resets to loading:true when filter changes', async () => {
    const { collection } = createMockCollection<Note>([
      { _id: '1', text: 'Pinned', pinned: true },
    ])
    const { result, rerender } = renderHook(
      ({ pinned }: { pinned: boolean }) => useFind(collection, { pinned }),
      { initialProps: { pinned: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender({ pinned: false })
    // loading must be true immediately after filter change
    expect(result.current.loading).toBe(true)
  })

  it('re-subscribes when the collection reference changes', async () => {
    const { collection: col1 } = createMockCollection<Note>()
    const { collection: col2, subscribeCount: count2 } = createMockCollection<Note>()

    const { rerender } = renderHook(
      ({ col }: { col: typeof col1 }) => useFind(col),
      { initialProps: { col: col1 } },
    )
    await waitFor(() => expect(count2()).toBe(0)) // not subscribed yet
    rerender({ col: col2 })
    await waitFor(() => expect(count2()).toBe(1)) // now subscribed to col2
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('useFind — cleanup', () => {
  it('calls unsubscribe when the component unmounts', async () => {
    const { collection, unsubscribeCount } = createMockCollection<Note>()
    const { unmount } = renderHook(() => useFind(collection))
    await waitFor(() => expect(unsubscribeCount()).toBe(0))
    unmount()
    expect(unsubscribeCount()).toBe(1)
  })

  it('calls unsubscribe for the old subscription when filter changes', async () => {
    const { collection, unsubscribeCount } = createMockCollection<Note>()
    const { rerender } = renderHook(
      ({ pinned }: { pinned: boolean }) => useFind(collection, { pinned }),
      { initialProps: { pinned: true } },
    )
    await waitFor(() => expect(unsubscribeCount()).toBe(0))
    rerender({ pinned: false })
    await waitFor(() => expect(unsubscribeCount()).toBe(1))
  })

  it('fires no more callbacks after unmount', async () => {
    const { collection, push } = createMockCollection<Note>()
    const onRender = vi.fn()
    const { unmount } = renderHook(() => {
      const res = useFind(collection)
      onRender(res.data.length)
      return res
    })
    await waitFor(() => expect(onRender).toHaveBeenCalled())
    const callsBefore = onRender.mock.calls.length

    unmount()
    act(() => push([{ _id: '1', text: 'After unmount', pinned: false }]))

    // Give microtasks a chance to flush
    await new Promise((r) => setTimeout(r, 0))
    expect(onRender.mock.calls.length).toBe(callsBefore)
  })
})
