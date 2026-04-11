/**
 * Unit tests for useCollection.
 *
 * useCollection reads the db from context and returns a memoised Collection<T>.
 * It should call db.collection() with the given name and return the same
 * reference across renders unless db or name changes.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { useState } from 'react'
import { TalaDBProvider } from '../../src/context'
import { useCollection } from '../../src/useCollection'
import { createMockDB } from '../helpers/mockCollection'

function wrapper(db: ReturnType<typeof createMockDB>['db']) {
  return ({ children }: { children: React.ReactNode }) => (
    <TalaDBProvider db={db}>{children}</TalaDBProvider>
  )
}

describe('useCollection', () => {
  it('returns a Collection from the context db', () => {
    const { db } = createMockDB()
    const { result } = renderHook(() => useCollection('notes'), { wrapper: wrapper(db) })
    expect(result.current).toBeDefined()
    expect(typeof result.current.find).toBe('function')
    expect(typeof result.current.subscribe).toBe('function')
  })

  it('calls db.collection() with the given name', () => {
    const { db } = createMockDB()
    const spy = vi.spyOn(db, 'collection')
    renderHook(() => useCollection('articles'), { wrapper: wrapper(db) })
    expect(spy).toHaveBeenCalledWith('articles')
  })

  it('returns the same reference across re-renders (memoised)', () => {
    const { db } = createMockDB()
    const { result, rerender } = renderHook(() => useCollection('notes'), {
      wrapper: wrapper(db),
    })
    const first = result.current
    rerender()
    rerender()
    expect(result.current).toBe(first)
  })

  it('returns a new reference when the collection name changes', () => {
    const { db } = createMockDB()
    const { result, rerender } = renderHook(
      ({ name }: { name: string }) => useCollection(name),
      { wrapper: wrapper(db), initialProps: { name: 'notes' } },
    )
    const first = result.current
    rerender({ name: 'articles' })
    expect(result.current).not.toBe(first)
  })

  it('calls db.collection() again when name changes', () => {
    const { db } = createMockDB()
    const spy = vi.spyOn(db, 'collection')
    const { rerender } = renderHook(
      ({ name }: { name: string }) => useCollection(name),
      { wrapper: wrapper(db), initialProps: { name: 'notes' } },
    )
    rerender({ name: 'articles' })
    expect(spy).toHaveBeenCalledWith('notes')
    expect(spy).toHaveBeenCalledWith('articles')
  })

  it('returns a new collection when the db instance changes', () => {
    const { db: db1 } = createMockDB()
    const { db: db2 } = createMockDB()

    // @testing-library/react doesn't forward rerender props to the wrapper —
    // use a stateful wrapper instead so the db can actually change.
    let setDb!: (db: typeof db1) => void
    const Wrapper = ({ children }: { children: React.ReactNode }) => {
      const [db, _set] = useState<typeof db1>(db1)
      setDb = _set
      return <TalaDBProvider db={db}>{children}</TalaDBProvider>
    }

    const { result } = renderHook(() => useCollection('notes'), { wrapper: Wrapper })
    const first = result.current

    act(() => setDb(db2))

    expect(result.current).not.toBe(first)
  })

  it('throws if called outside TalaDBProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useCollection('notes'))).toThrow()
    spy.mockRestore()
  })
})
