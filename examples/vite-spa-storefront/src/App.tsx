/**
 * Coverage-first replication in a Vite SPA — the case with no SSR to hide behind.
 *
 * Watch the **request counter**. It ticks up while the catalog hydrates, and then
 * stops. From that point on, every interaction — paging, filtering, sorting, going
 * back to page 1 — is answered by the on-device database. Turn off your network and
 * keep browsing.
 *
 * That counter reaching a fixed number and *staying there* is the entire point. A
 * page cache would keep climbing every time you touched a filter it hadn't seen.
 */
import { useEffect, useState } from 'react'
import { TalaDBProvider, ReplicationProvider, useQuery, useCoverage } from '@taladb/react'
import type { Document } from 'taladb'

// Extends `Document` rather than redeclaring `_id`: TalaDB documents carry an index
// signature, and a plain interface without one doesn't satisfy the `Document`
// constraint on `useQuery<T>`.
interface Product extends Document {
  sku: string
  name: string
  price: number
  category: string
  thumb: string
}

const API = 'http://localhost:8787'
const CATEGORIES = ['all', 'kitchen', 'garden', 'office', 'outdoor', 'lighting']
const PAGE_SIZE = 24

/** Reads the origin's own request counter — proof, not a claim. */
function RequestCounter() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const tick = () =>
      fetch(`${API}/api/requests`)
        .then((r) => r.json())
        .then((d) => setCount(d.count))
        .catch(() => {})
    tick()
    // NOTE: this poll is the demo's scoreboard, not part of replication. It hits
    // /api/requests, which is deliberately not counted.
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="counter">
      <span className="counter-num">{count}</span>
      <span className="counter-label">requests to the origin, since boot</span>
    </div>
  )
}

function Catalog() {
  const [page, setPage] = useState(1)
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<1 | -1>(1)

  const coverage = useCoverage('products')

  const { data, loading } = useQuery<Product>({
    collection: 'products',
    filter: category === 'all' ? undefined : { category },
    sort: { price: sort },
    page,
    limit: PAGE_SIZE,
  })

  return (
    <>
      <header>
        <div>
          <h1>Storefront</h1>
          <p className="sub">
            {coverage.ready ? (
              <span className="ok">
                ✓ {coverage.rows.toLocaleString()} products replicated locally — every query
                below is served from the device
              </span>
            ) : coverage.status === 'hydrating' ? (
              <span>
                Hydrating… {Math.round((coverage.progress ?? 0) * 100)}% (
                {coverage.rows.toLocaleString()} rows). Serving from the network meanwhile.
              </span>
            ) : coverage.status === 'best-effort' ? (
              <span className="warn">
                Best-effort: the origin could not pin a snapshot, so we can't prove the replica
                is whole. Still reading from the network.
              </span>
            ) : (
              <span>Cold start — bridging from the origin…</span>
            )}
          </p>
        </div>
        <RequestCounter />
      </header>

      <div className="controls">
        <div className="chips">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={c === category ? 'chip on' : 'chip'}
              onClick={() => {
                setCategory(c)
                setPage(1)
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <button className="chip" onClick={() => setSort((s) => (s === 1 ? -1 : 1))}>
          price {sort === 1 ? '↑' : '↓'}
        </button>
      </div>

      {loading ? (
        <p className="empty">Loading…</p>
      ) : data.length === 0 ? (
        <p className="empty">No products on this page.</p>
      ) : (
        <div className="grid">
          {data.map((p) => (
            <article key={p._id} className="card">
              <div className="thumb" />
              <h3>{p.name}</h3>
              <p className="cat">{p.category}</p>
              <p className="price">₱{p.price.toLocaleString()}</p>
            </article>
          ))}
        </div>
      )}

      <nav className="pager">
        <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
          ← prev
        </button>
        <span>page {page}</span>
        <button disabled={data.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
          next →
        </button>
      </nav>

      <footer>
        Page freely, change the filter, flip the sort, come back to page 1 — once coverage is
        ready, the counter above <strong>stops moving</strong>. Then kill your network and try
        again.
      </footer>
    </>
  )
}

export default function App() {
  return (
    <TalaDBProvider name="storefront.db" fallback={<p className="empty">Opening database…</p>}>
      <ReplicationProvider
        replicate={{
          products: {
            endpoint: `${API}/api/products`,
            key: 'id',
            // A slim index: ~100 bytes a row, so a big catalog is a small download.
            // Search, filter, sort and paging all run off this. Full product detail
            // would be lazy-loaded into a *separate* collection — never as extra
            // fields here, since a remote write replaces the whole document and
            // would erase them.
            mapRow: (r: any) => ({
              sku: r.id,
              name: r.name,
              price: r.price,
              category: r.category,
              thumb: r.thumb,
            }),
            hydrate: 'eager',
            pageSize: 500,
            refreshMs: 15_000,
            pagination: 'offset',
            delta: true,
            revision: 'rev',
            toParams: (q) => ({
              ...(q.page && q.limit ? { page: String((q.page - 1) * q.limit) } : {}),
              ...(q.limit ? { limit: String(q.limit) } : {}),
              ...(typeof q.filter?.category === 'string' ? { category: q.filter.category } : {}),
              ...(q.sort?.price
                ? { sort: 'price', order: q.sort.price === -1 ? 'desc' : 'asc' }
                : {}),
            }),
          },
        }}
      >
        <Catalog />
      </ReplicationProvider>
    </TalaDBProvider>
  )
}
