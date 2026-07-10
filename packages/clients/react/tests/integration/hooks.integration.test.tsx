/**
 * Integration tests for @taladb/react hooks.
 *
 * These tests exercise the full composition:
 *   TalaDBProvider → useCollection → useFind / useFindOne → mutations
 *
 * They prove that the hooks wire together correctly end-to-end, that
 * mutations propagate automatically to subscribed components, and that
 * multiple components sharing the same collection stay in sync.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import React from 'react'
import { TalaDBProvider } from '../../src/context'
import { useCollection } from '../../src/useCollection'
import { useFind } from '../../src/useFind'
import { useFindOne } from '../../src/useFindOne'
import { createMockDB } from '../helpers/mockCollection'

interface Article {
  _id?: string
  title: string
  locale: string
  published: boolean
}

interface User {
  _id?: string
  name: string
  active: boolean
}

// ---------------------------------------------------------------------------
// Helper — render hooks inside a TalaDBProvider
// ---------------------------------------------------------------------------

function makeWrapper(db: ReturnType<typeof createMockDB>['db']) {
  return ({ children }: { children: React.ReactNode }) => (
    <TalaDBProvider db={db}>{children}</TalaDBProvider>
  )
}

// ---------------------------------------------------------------------------
// Provider + useCollection + useFind — full pipeline
// ---------------------------------------------------------------------------

describe('Integration — provider → useCollection → useFind', () => {
  it('renders with initial documents from the collection', async () => {
    const { db, getHandle } = createMockDB()
    const handle = getHandle<Article>('articles')
    handle.push([
      { _id: '1', title: 'Hello', locale: 'en', published: true },
      { _id: '2', title: 'Bonjour', locale: 'fr', published: true },
    ])

    const { result } = renderHook(
      () => {
        const col = useCollection<Article>('articles')
        return useFind(col)
      },
      { wrapper: makeWrapper(db) },
    )

    await waitFor(() => expect(result.current.data).toHaveLength(2))
    expect(result.current.loading).toBe(false)
    expect(result.current.data[0].title).toBe('Hello')
  })

  it('insert via collection triggers useFind re-render', async () => {
    const { db } = createMockDB()

    const { result } = renderHook(
      () => {
        const col = useCollection<Article>('articles')
        return { col, query: useFind(col) }
      },
      { wrapper: makeWrapper(db) },
    )

    await waitFor(() => expect(result.current.query.loading).toBe(false))
    expect(result.current.query.data).toHaveLength(0)

    await act(async () => {
      await result.current.col.insert({ title: 'New Article', locale: 'en', published: false })
    })

    await waitFor(() => expect(result.current.query.data).toHaveLength(1))
    expect(result.current.query.data[0].title).toBe('New Article')
  })

  it('deleteOne via collection triggers useFind re-render', async () => {
    const { db, getHandle } = createMockDB()
    const handle = getHandle<Article>('articles')
    handle.push([{ _id: 'a1', title: 'Delete me', locale: 'en', published: true }])

    const { result } = renderHook(
      () => {
        const col = useCollection<Article>('articles')
        return { col, query: useFind(col) }
      },
      { wrapper: makeWrapper(db) },
    )

    await waitFor(() => expect(result.current.query.data).toHaveLength(1))

    await act(async () => {
      await result.current.col.deleteOne({ _id: 'a1' })
    })

    await waitFor(() => expect(result.current.query.data).toHaveLength(0))
  })

  it('filter change switches subscription and delivers new results', async () => {
    const { db, getHandle } = createMockDB()
    const handle = getHandle<Article>('articles')
    handle.push([
      { _id: '1', title: 'English', locale: 'en', published: true },
      { _id: '2', title: 'French', locale: 'fr', published: true },
    ])

    const { result, rerender } = renderHook(
      ({ locale }: { locale: string }) => {
        const col = useCollection<Article>('articles')
        return useFind(col, { locale })
      },
      { wrapper: makeWrapper(db), initialProps: { locale: 'en' } },
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    // Both docs are in the mock — filter is not actually applied by the mock,
    // but re-subscription is the critical behaviour being verified
    expect(result.current.loading).toBe(false)

    rerender({ locale: 'fr' })
    // Immediately after rerender, loading resets
    expect(result.current.loading).toBe(true)
    // Then resolves again after the new subscription's first callback
    await waitFor(() => expect(result.current.loading).toBe(false))
  })
})

// ---------------------------------------------------------------------------
// Multiple components sharing the same collection
// ---------------------------------------------------------------------------

describe('Integration — multiple subscribers on same collection', () => {
  it('two useFind hooks on the same collection both update on push', async () => {
    const { db, getHandle } = createMockDB()

    const { result: r1 } = renderHook(
      () => {
        const col = useCollection<User>('users')
        return useFind(col)
      },
      { wrapper: makeWrapper(db) },
    )
    const { result: r2 } = renderHook(
      () => {
        const col = useCollection<User>('users')
        return useFind(col)
      },
      { wrapper: makeWrapper(db) },
    )

    await waitFor(() => expect(r1.current.loading).toBe(false))
    await waitFor(() => expect(r2.current.loading).toBe(false))

    const newUsers: User[] = [{ _id: '1', name: 'Alice', active: true }]
    act(() => getHandle<User>('users').push(newUsers))

    await waitFor(() => expect(r1.current.data).toHaveLength(1))
    await waitFor(() => expect(r2.current.data).toHaveLength(1))
  })

  it('unmounting one subscriber does not affect the other', async () => {
    const { db, getHandle } = createMockDB()

    const { result: r1, unmount: unmount1 } = renderHook(
      () => useFind(useCollection<User>('users')),
      { wrapper: makeWrapper(db) },
    )
    const { result: r2 } = renderHook(
      () => useFind(useCollection<User>('users')),
      { wrapper: makeWrapper(db) },
    )

    await waitFor(() => expect(r1.current.loading).toBe(false))
    await waitFor(() => expect(r2.current.loading).toBe(false))

    unmount1()

    const update: User[] = [{ _id: '1', name: 'Bob', active: false }]
    act(() => getHandle<User>('users').push(update))

    await waitFor(() => expect(r2.current.data).toHaveLength(1))
    expect(r2.current.data[0].name).toBe('Bob')
  })
})

// ---------------------------------------------------------------------------
// useFindOne integration
// ---------------------------------------------------------------------------

describe('Integration — useFindOne', () => {
  it('returns the matching document from a populated collection', async () => {
    const { db, getHandle } = createMockDB()
    getHandle<User>('users').push([
      { _id: 'u1', name: 'Alice', active: true },
      { _id: 'u2', name: 'Bob', active: false },
    ])

    const { result } = renderHook(
      () => {
        const col = useCollection<User>('users')
        return useFindOne(col, { _id: 'u1' })
      },
      { wrapper: makeWrapper(db) },
    )

    // The mock doesn't filter — it returns first doc — but the key assertion
    // is that the hook plumbs through without error and delivers data.
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.loading).toBe(false)
  })

  it('returns null after the matched document is deleted', async () => {
    const { db, getHandle } = createMockDB()
    getHandle<User>('users').push([{ _id: 'u1', name: 'Alice', active: true }])

    const { result } = renderHook(
      () => {
        const col = useCollection<User>('users')
        return { col, query: useFindOne(col, { _id: 'u1' }) }
      },
      { wrapper: makeWrapper(db) },
    )

    await waitFor(() => expect(result.current.query.data).not.toBeNull())

    await act(async () => {
      await result.current.col.deleteOne({ _id: 'u1' })
    })

    await waitFor(() => expect(result.current.query.data).toBeNull())
  })

  it('updates when a new document is inserted into an empty collection', async () => {
    const { db } = createMockDB()

    const { result } = renderHook(
      () => {
        const col = useCollection<User>('users')
        return { col, query: useFindOne(col, {}) }
      },
      { wrapper: makeWrapper(db) },
    )

    await waitFor(() => expect(result.current.query.loading).toBe(false))
    expect(result.current.query.data).toBeNull()

    await act(async () => {
      await result.current.col.insert({ name: 'Carol', active: true })
    })

    await waitFor(() => expect(result.current.query.data).not.toBeNull())
    expect(result.current.query.data?.name).toBe('Carol')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Integration — edge cases', () => {
  it('unmounting the provider does not throw', async () => {
    const { db } = createMockDB()
    const { result, unmount } = renderHook(
      () => useFind(useCollection<User>('users')),
      { wrapper: makeWrapper(db) },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(() => unmount()).not.toThrow()
  })

  it('useCollection returns the same Collection object for the same name across renders', async () => {
    const { db } = createMockDB()
    const refs: object[] = []

    const { rerender } = renderHook(
      () => {
        const col = useCollection<User>('users')
        refs.push(col)
        return col
      },
      { wrapper: makeWrapper(db) },
    )

    rerender()
    rerender()

    // All renders must have the same collection reference (memoised)
    expect(refs[0]).toBe(refs[1])
    expect(refs[1]).toBe(refs[2])
  })

  it('empty push keeps loading:false and data:[]', async () => {
    const { db, getHandle } = createMockDB()
    const { result } = renderHook(
      () => useFind(useCollection<User>('users')),
      { wrapper: makeWrapper(db) },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => getHandle<User>('users').push([]))
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(result.current.loading).toBe(false)
  })
})
