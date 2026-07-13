/**
 * `useQueries` — several pages, several collections, one hook.
 *
 * Same guarantee as `useQuery`: once each collection is covered, every read is
 * local. Worth pinning separately because it manages its own subscriptions (hooks
 * can't be called in a variable-length loop), so it is a second place the
 * "no network once covered" property could regress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TalaDBProvider } from '../../src/context'
import { ReplicationProvider } from '../../src/replication/config'
import { useQueries } from '../../src/useQueries'
import { createMockDB } from '../helpers/mockCollection'
import type { Document, TalaDB } from 'taladb'

function originFor(rows: Record<string, unknown>[]) {
  let calls = 0
  const fetch = vi.fn(async () => {
    calls++
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: rows,
        nextPage: null,
        snapshot: 'snap-1',
        deltaCursor: 'seq-0',
        total: rows.length,
      }),
    } as Response
  }) as unknown as typeof fetch
  return {
    fetch,
    calls: () => calls,
    reset: () => {
      calls = 0
    },
  }
}

const productRows = Array.from({ length: 6 }, (_, i) => ({
  id: `p${i}`,
  name: `prod${i}`,
  price: i,
  rev: i + 1,
}))
const categoryRows = [
  { id: 'c1', label: 'Kitchen', rev: 1 },
  { id: 'c2', label: 'Garden', rev: 2 },
]

let db: TalaDB

beforeEach(() => {
  db = createMockDB().db as unknown as TalaDB
})

function wrapperWith(products: typeof fetch, categories: typeof fetch) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TalaDBProvider db={db}>
        <ReplicationProvider
          replicate={{
            products: {
              endpoint: '/api/products',
              fetch: products,
              hydrate: 'eager',
              mapRow: (r: any) => ({ sku: r.id, name: r.name, price: r.price }),
            },
            categories: {
              endpoint: '/api/categories',
              fetch: categories,
              hydrate: 'eager',
              mapRow: (r: any) => ({ slug: r.id, label: r.label }),
            },
          }}
        >
          {children}
        </ReplicationProvider>
      </TalaDBProvider>
    )
  }
}

describe('useQueries', () => {
  it('returns index-aligned results for several collections', async () => {
    const p = originFor(productRows)
    const c = originFor(categoryRows)

    const { result } = renderHook(
      () =>
        useQueries([
          { collection: 'products', sort: { price: 1 }, limit: 3 },
          { collection: 'categories' },
        ] as never),
      { wrapper: wrapperWith(p.fetch, c.fetch) },
    )

    await waitFor(() => expect(result.current[0]!.data).toHaveLength(3))
    await waitFor(() => expect(result.current[1]!.data).toHaveLength(2))

    expect((result.current[0]!.data[0] as Document).sku).toBe('p0')
    expect((result.current[1]!.data[0] as Document).label).toBe('Kitchen')
  })

  it('hydrates each collection from its own origin', async () => {
    const p = originFor(productRows)
    const c = originFor(categoryRows)

    const { result } = renderHook(
      () => useQueries([{ collection: 'products' }, { collection: 'categories' }] as never),
      { wrapper: wrapperWith(p.fetch, c.fetch) },
    )

    await waitFor(() => expect(result.current[0]!.coverage.ready).toBe(true))
    await waitFor(() => expect(result.current[1]!.coverage.ready).toBe(true))

    expect(p.calls()).toBeGreaterThan(0)
    expect(c.calls()).toBeGreaterThan(0)
  })

  it('pages locally once covered, with no further requests', async () => {
    const p = originFor(productRows)
    const c = originFor(categoryRows)
    const wrapper = wrapperWith(p.fetch, c.fetch)

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) =>
        useQueries([{ collection: 'products', sort: { price: 1 }, page, limit: 2 }] as never),
      { wrapper, initialProps: { page: 1 } },
    )

    await waitFor(() => expect(result.current[0]!.coverage.ready).toBe(true))
    await waitFor(() => expect(result.current[0]!.data).toHaveLength(2))

    p.reset()
    c.reset()

    rerender({ page: 2 })
    await waitFor(() => expect((result.current[0]!.data[0] as Document).sku).toBe('p2'))

    expect(p.calls(), 'paging a covered collection must not hit the network').toBe(0)
  })

  it('skips a disabled entry', async () => {
    const p = originFor(productRows)
    const c = originFor(categoryRows)

    const { result } = renderHook(
      () =>
        useQueries([
          { collection: 'products' },
          { collection: 'categories', enabled: false },
        ] as never),
      { wrapper: wrapperWith(p.fetch, c.fetch) },
    )

    await waitFor(() => expect(result.current[0]!.data.length).toBeGreaterThan(0))
    expect(result.current[1]!.data).toEqual([])
  })
})
