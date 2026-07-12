/**
 * `useQuery` — the coverage-first read path.
 *
 * The headline claim, and the thing most of these tests exist to pin down:
 * **once a collection is covered, `useQuery` never touches the network.** Page 1,
 * page 2, a new filter, a new sort, page 47, back to page 1 — every one is a local
 * query against the on-device database. If a regression ever reintroduces a fetch
 * on a covered collection, `expect(fetchCount).toBe(0)` is what catches it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TalaDBProvider } from '../../src/context'
import { ReplicationProvider } from '../../src/replication/config'
import { useQuery } from '../../src/useQuery'
import { createMockDB } from '../helpers/mockCollection'
import type { Document, TalaDB } from 'taladb'

interface Product extends Document {
  sku: string
  name: string
  price: number
  category: string
}

const CATALOG: Product[] = Array.from({ length: 12 }, (_, i) => ({
  _id: `id-${i}`,
  sku: `sku-${i}`,
  name: `p${i}`,
  price: i * 10,
  category: i % 2 === 0 ? 'kitchen' : 'garden',
}))

/** A mock origin that counts every request it serves. */
function makeOrigin(rows: Product[] = CATALOG) {
  let calls = 0
  const fetch = vi.fn(async (url: string) => {
    calls++
    const u = new URL(String(url), 'http://x')
    const page = Number(u.searchParams.get('page') ?? 0)
    const limit = Number(u.searchParams.get('limit') ?? 500)
    const offset = u.searchParams.has('page') && page > 0 ? (page - 1) * limit : page
    const slice = rows.slice(offset, offset + limit)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: slice.map((r) => ({
          id: r.sku,
          name: r.name,
          price: r.price,
          category: r.category,
          rev: Number(r.sku.split('-')[1]) + 1,
        })),
        nextPage: offset + limit >= rows.length ? null : offset + limit,
        snapshot: 'snap-1',
        deltaCursor: 'seq-0',
        total: rows.length,
      }),
    } as Response
  }) as unknown as typeof fetch

  return { fetch, calls: () => calls, reset: () => { calls = 0 } }
}

function makeWrapper(db: TalaDB, fetch: typeof fetch, extra: Record<string, unknown> = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TalaDBProvider db={db}>
        <ReplicationProvider
          replicate={{
            products: {
              endpoint: '/api/products',
              key: 'id',
              fetch,
              hydrate: 'eager',
              pageSize: 100,
              mapRow: (r: any) => ({ sku: r.id, name: r.name, price: r.price, category: r.category }),
              ...extra,
            },
          }}
        >
          {children}
        </ReplicationProvider>
      </TalaDBProvider>
    )
  }
}

let db: TalaDB
let getHandle: ReturnType<typeof createMockDB>['getHandle']

beforeEach(() => {
  const mock = createMockDB()
  db = mock.db as unknown as TalaDB
  getHandle = mock.getHandle
})

describe('useQuery — once covered, reads are local', () => {
  it('hydrates the collection and reports coverage ready', async () => {
    const origin = makeOrigin()
    const { result } = renderHook(() => useQuery<Product>({ collection: 'products' }), {
      wrapper: makeWrapper(db, origin.fetch),
    })

    await waitFor(() => expect(result.current.coverage.ready).toBe(true))
    expect(result.current.data).toHaveLength(12)
  })

  it('serves page 1 → page 2 → back to page 1 with ZERO further requests', async () => {
    // The whole point of the redesign. Not "page 1 is cached" — *nothing* is
    // fetched, because pagination stopped being a network concern.
    const origin = makeOrigin()
    const wrapper = makeWrapper(db, origin.fetch)

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) =>
        useQuery<Product>({ collection: 'products', sort: { price: 1 }, page, limit: 5 }),
      { wrapper, initialProps: { page: 1 } },
    )

    await waitFor(() => expect(result.current.coverage.ready).toBe(true))
    await waitFor(() => expect(result.current.data).toHaveLength(5))
    expect(result.current.data[0]!.price).toBe(0)

    origin.reset()

    rerender({ page: 2 })
    await waitFor(() => expect(result.current.data[0]!.price).toBe(50))
    expect(result.current.data).toHaveLength(5)

    rerender({ page: 1 })
    await waitFor(() => expect(result.current.data[0]!.price).toBe(0))

    expect(origin.calls(), 'paging a covered collection must not hit the network').toBe(0)
  })

  it('filters and sorts locally, with no requests', async () => {
    const origin = makeOrigin()
    const wrapper = makeWrapper(db, origin.fetch)

    const { result, rerender } = renderHook(
      ({ category }: { category: string }) =>
        useQuery<Product>({
          collection: 'products',
          filter: { category } as never,
          sort: { price: -1 },
        }),
      { wrapper, initialProps: { category: 'kitchen' } },
    )

    await waitFor(() => expect(result.current.coverage.ready).toBe(true))
    await waitFor(() => expect(result.current.data.length).toBeGreaterThan(0))
    expect(result.current.data.every((p) => p.category === 'kitchen')).toBe(true)
    expect(result.current.data[0]!.price).toBe(100) // descending

    origin.reset()

    // A filter nobody has ever fetched — a page cache could not answer this.
    rerender({ category: 'garden' })
    await waitFor(() => expect(result.current.data.every((p) => p.category === 'garden')).toBe(true))

    expect(origin.calls(), 'a novel filter must still be answerable locally').toBe(0)
  })

  it('re-renders as hydration lands, rather than freezing on a dead snapshot', async () => {
    // `aggregate` alone returns a snapshot that never re-runs. If useQuery called
    // it in an effect instead of subscribing, the page would sit empty forever
    // while rows arrived underneath it.
    const origin = makeOrigin()
    const { result } = renderHook(
      () => useQuery<Product>({ collection: 'products', sort: { price: 1 }, limit: 3 }),
      { wrapper: makeWrapper(db, origin.fetch) },
    )

    await waitFor(() => expect(result.current.data).toHaveLength(3))
    expect(result.current.data.map((p) => p.sku)).toEqual(['sku-0', 'sku-1', 'sku-2'])
  })
})

describe('useQuery — cold start', () => {
  it('does not claim readiness before hydration completes', async () => {
    const origin = makeOrigin()
    const { result } = renderHook(
      () => useQuery<Product>({ collection: 'products', hydrate: 'manual' } as never),
      { wrapper: makeWrapper(db, origin.fetch, { hydrate: 'manual' }) },
    )

    // With hydration off, coverage must stay un-ready — a bridged page must never
    // masquerade as a covered catalog.
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.coverage.ready).toBe(false)
  })

  it('bridges the current query so a cold start paints', async () => {
    const origin = makeOrigin()
    const { result } = renderHook(
      () => useQuery<Product>({ collection: 'products', page: 1, limit: 4 }),
      { wrapper: makeWrapper(db, origin.fetch, { hydrate: 'manual' }) },
    )

    // No background walk, but the bridge still fills this page from the origin.
    await waitFor(() => expect(result.current.data.length).toBeGreaterThan(0))
    expect(origin.calls()).toBeGreaterThan(0)
  })

  it('does not apply the page offset twice to a bridged page 2', async () => {
    const origin = makeOrigin()
    const { result } = renderHook(
      () => useQuery<Product>({ collection: 'products', sort: { price: 1 }, page: 2, limit: 4 }),
      { wrapper: makeWrapper(db, origin.fetch, { hydrate: 'manual' }) },
    )

    await waitFor(() => expect(result.current.data).toHaveLength(4))
    expect(result.current.data.map((p) => p.price)).toEqual([40, 50, 60, 70])
    expect(result.current.coverage.ready).toBe(false)
  })

  it('the bridge merges into the replica rather than duplicating it', async () => {
    // Bridged rows and hydrated rows are the *same* rows, under the same derived
    // ids. If they diverged, the catalog would double.
    const origin = makeOrigin()
    const { result } = renderHook(
      () => useQuery<Product>({ collection: 'products', page: 1, limit: 4 }),
      { wrapper: makeWrapper(db, origin.fetch, { hydrate: 'eager' }) },
    )

    await waitFor(() => expect(result.current.coverage.ready).toBe(true))
    expect(
      getHandle('products').docs(),
      'the walk must overwrite the bridged rows in place',
    ).toHaveLength(12)
  })
})

describe('useQuery — enabled', () => {
  it('reads nothing when disabled', async () => {
    const origin = makeOrigin()
    const { result } = renderHook(
      () => useQuery<Product>({ collection: 'products', enabled: false }),
      { wrapper: makeWrapper(db, origin.fetch, { hydrate: 'manual' }) },
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual([])
    expect(origin.calls()).toBe(0)
  })
})
