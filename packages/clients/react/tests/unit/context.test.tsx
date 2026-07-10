/**
 * Unit tests for TalaDBProvider and useTalaDB.
 *
 * Verifies that the context correctly provides the db instance to consumers
 * and throws a clear error when used outside a provider.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import React from 'react'
import { TalaDBProvider, useTalaDB } from '../../src/context'
import { createMockDB } from '../helpers/mockCollection'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper(db: ReturnType<typeof createMockDB>['db']) {
  return ({ children }: { children: React.ReactNode }) => (
    <TalaDBProvider db={db}>{children}</TalaDBProvider>
  )
}

// ---------------------------------------------------------------------------
// TalaDBProvider
// ---------------------------------------------------------------------------

describe('TalaDBProvider', () => {
  it('renders children without crashing', () => {
    const { db } = createMockDB()
    const { result } = renderHook(() => useTalaDB(), { wrapper: wrapper(db) })
    expect(result.current).toBeDefined()
  })

  it('provides the exact db instance passed as prop', () => {
    const { db } = createMockDB()
    const { result } = renderHook(() => useTalaDB(), { wrapper: wrapper(db) })
    expect(result.current).toBe(db)
  })

  it('returns the same db reference across re-renders', () => {
    const { db } = createMockDB()
    const { result, rerender } = renderHook(() => useTalaDB(), { wrapper: wrapper(db) })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('nested providers — inner db shadows the outer', () => {
    const { db: outer } = createMockDB()
    const { db: inner } = createMockDB()

    const Nested = ({ children }: { children: React.ReactNode }) => (
      <TalaDBProvider db={outer}>
        <TalaDBProvider db={inner}>{children}</TalaDBProvider>
      </TalaDBProvider>
    )

    const { result } = renderHook(() => useTalaDB(), { wrapper: Nested })
    expect(result.current).toBe(inner)
    expect(result.current).not.toBe(outer)
  })
})

// ---------------------------------------------------------------------------
// useTalaDB — error boundary
// ---------------------------------------------------------------------------

describe('useTalaDB', () => {
  it('throws when called outside a TalaDBProvider', () => {
    // Suppress the React error boundary console.error noise in test output
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useTalaDB())).toThrow(
      'useTalaDB must be used inside <TalaDBProvider db={...}>',
    )
    spy.mockRestore()
  })

  it('error message mentions TalaDBProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderHook(() => useTalaDB())
    } catch (e) {
      expect((e as Error).message).toContain('TalaDBProvider')
    }
    spy.mockRestore()
  })
})
