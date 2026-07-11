'use client';

import { useState } from 'react';
import { useQuery, useQueries, useMutation } from '@taladb/react';
import type { Product, Category, Order, OrderStatus } from './lib/types';

export default function Home() {
  return (
    <main>
      <h1>TalaDB — scoped replication hooks</h1>
      <p>
        Every section below binds to a slice of the seeded dummy origin at{' '}
        <code>/api/sync</code> and reads through the local replica. Reads are live
        queries over the local collection; the network pull writes into that same
        collection, so the view re-renders on its own — no <code>queryKey</code>,
        no <code>invalidateQueries</code>.
      </p>

      <ProductsQuery />
      <Dashboard />
      <Orders />

      <hr style={{ margin: '2rem 0' }} />
      <p style={{ fontSize: 14, color: '#666' }}>
        <strong>prefetch</strong> runs invisibly: <code>&lt;ReplicationProvider prefetch=
        {'{['}products,&nbsp;categories]{'}'}&gt;</code> warms those slices into the
        local replica in the background on first load (idle-deferred), so the
        Products list is already local when this page mounts. Open the Network tab
        and reload — the <code>/api/sync/pull</code> calls fire before you interact.
      </p>
    </main>
  );
}

// ── useQuery ──────────────────────────────────────────────────────────────
// One slice, live-filtered locally, background-refreshed on the provider's poll.
function ProductsQuery() {
  const [category, setCategory] = useState<string>('kitchen');
  const { data, loading, syncing, syncError, refetch } = useQuery<Product>({
    collection: 'products',
    filter: { category },
    source: 'local-first',
  });

  return (
    <section>
      <h2>
        useQuery — products{' '}
        <small style={{ fontWeight: 400, color: '#888' }}>
          {syncing ? 'syncing…' : 'idle'}
        </small>
      </h2>
      <label>
        category:{' '}
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="kitchen">kitchen</option>
          <option value="outdoor">outdoor</option>
          <option value="office">office</option>
        </select>
      </label>{' '}
      <button onClick={() => void refetch()}>refetch</button>
      {syncError ? <p style={{ color: 'crimson' }}>sync error (serving local)</p> : null}
      {loading ? (
        <p>loading…</p>
      ) : (
        <ul>
          {data.map((p) => (
            <li key={p._id}>
              {p.name} — ${p.price} · {p.stock} in stock
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── useQueries ──────────────────────────────────────────────────────────────
// Several slices at once, index-aligned with the input array.
function Dashboard() {
  const [orders, categories] = useQueries([
    { collection: 'orders' },
    { collection: 'categories' },
  ]);

  return (
    <section>
      <h2>useQueries — dashboard</h2>
      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        <div>
          <h3>orders ({orders.loading ? '…' : orders.data.length})</h3>
          <ul>
            {(orders.data as Order[]).map((o) => (
              <li key={o._id}>
                {o.ref} — {o.status}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>categories ({categories.loading ? '…' : categories.data.length})</h3>
          <ul>
            {(categories.data as Category[]).map((c) => (
              <li key={c._id}>
                {c.name} — {c.blurb}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ── useMutation ──────────────────────────────────────────────────────────────
// Local-first write, then replicated out. The useQuery below re-renders the
// instant the local write lands — before the push settles.
const STATUSES: OrderStatus[] = ['pending', 'paid', 'shipped'];

function Orders() {
  const { data: orders } = useQuery<Order>({ collection: 'orders' });
  const { mutate, pending, error } = useMutation<Order>({ collection: 'orders' });
  const [customer, setCustomer] = useState('');

  const nextStatus = (s: OrderStatus): OrderStatus =>
    STATUSES[(STATUSES.indexOf(s) + 1) % STATUSES.length];

  return (
    <section>
      <h2>
        useMutation — orders{' '}
        <small style={{ fontWeight: 400, color: '#888' }}>{pending ? 'writing…' : ''}</small>
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = customer.trim();
          if (!name) return;
          mutate({
            type: 'insert',
            doc: {
              ref: `A-${1000 + Math.floor(Math.random() * 9000)}`,
              customer: name,
              total: Math.floor(Math.random() * 200),
              status: 'pending',
            },
          });
          setCustomer('');
        }}
      >
        <input
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          placeholder="new order for…"
        />
        <button type="submit">add order</button>
      </form>
      {error ? <p style={{ color: 'crimson' }}>write error (local write is durable)</p> : null}
      <ul>
        {orders.map((o) => (
          <li key={o._id}>
            {o.ref} — {o.customer} — ${o.total} —{' '}
            <button
              onClick={() =>
                mutate({
                  type: 'update',
                  where: { _id: o._id },
                  set: { status: nextStatus(o.status) },
                })
              }
            >
              {o.status} →
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
