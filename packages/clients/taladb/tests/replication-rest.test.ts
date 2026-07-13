import { describe, expect, it, vi } from 'vitest';
import { createRestSource } from '../src/replication/rest';

/** A `fetch` that replies with `body` and records the URLs it was called with. */
function mockFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    urls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, urls };
}

const source = (body: unknown, extra: Record<string, unknown> = {}, status = 200) => {
  const m = mockFetch(body, status);
  return {
    src: createRestSource({
      endpoint: '/api/products',
      collection: 'products',
      fetch: m.fetch,
      ...extra,
    }),
    urls: m.urls,
  };
};

describe('createRestSource — envelope detection', () => {
  it('reads a bare array', async () => {
    const { src } = source([{ id: '1' }, { id: '2' }]);
    const page = await src.bootstrap({ page: null, snapshot: null, limit: 500 });
    expect(page.rows).toHaveLength(2);
  });

  it.each(['data', 'items', 'rows'])('reads a { %s } envelope', async (field) => {
    const { src } = source({ [field]: [{ id: '1' }] });
    const page = await src.bootstrap({ page: null, snapshot: null, limit: 500 });
    expect(page.rows).toHaveLength(1);
  });

  it('throws a useful error rather than guessing at an unknown envelope', async () => {
    // Guessing wrong here yields an *empty replica that reports itself complete* —
    // silently wrong, and much worse than failing at startup.
    const { src } = source({ payload: { results: [{ id: '1' }] } });
    await expect(src.bootstrap({ page: null, snapshot: null, limit: 500 })).rejects.toThrow(
      /could not find a row array.*keys: payload/s,
    );
  });

  it('accepts a custom parse for an unknown envelope', async () => {
    const { src } = source(
      { payload: { results: [{ id: '1' }] } },
      { parse: (b: any) => b.payload.results },
    );
    const page = await src.bootstrap({ page: null, snapshot: null, limit: 500 });
    expect(page.rows).toHaveLength(1);
  });

  it('surfaces a non-2xx response', async () => {
    const { src } = source([], {}, 500);
    await expect(src.bootstrap({ page: null, snapshot: null, limit: 500 })).rejects.toThrow(
      /responded 500/,
    );
  });
});

describe('createRestSource — bootstrap', () => {
  it('preserves an absolute cross-origin endpoint', async () => {
    const m = mockFetch({ data: [] });
    const src = createRestSource({
      endpoint: 'https://api.example.com/products',
      collection: 'products',
      fetch: m.fetch,
    });
    await src.bootstrap({ page: null, snapshot: null, limit: 10 });
    expect(m.urls[0]).toMatch(/^https:\/\/api\.example\.com\/products/);
  });
  it('passes page, limit and snapshot through to the origin', async () => {
    const { src, urls } = source({ data: [], snapshot: 'snap-1' });
    await src.bootstrap({ page: 100, snapshot: 'snap-1', limit: 50 });

    expect(urls[0]).toContain('limit=50');
    expect(urls[0]).toContain('page=100');
    expect(urls[0]).toContain('snapshot=snap-1');
  });

  it('surfaces the snapshot, delta cursor and total', async () => {
    const { src } = source({
      data: [{ id: '1' }],
      snapshot: 'snap-abc',
      deltaCursor: 'seq-9812',
      total: 100_000,
    });
    const page = await src.bootstrap({ page: null, snapshot: null, limit: 500 });

    expect(page.snapshot).toBe('snap-abc');
    expect(page.deltaCursor).toBe('seq-9812');
    expect(page.total).toBe(100_000);
  });

  it('omits the snapshot when the origin does not issue one', async () => {
    // The coordinator reads this absence and caps coverage at `best-effort`.
    const { src } = source({ data: [{ id: '1' }] });
    const page = await src.bootstrap({ page: null, snapshot: null, limit: 500 });
    expect(page.snapshot).toBeUndefined();
  });

  it('treats a short page as the end of the walk', async () => {
    const { src } = source({ data: [{ id: '1' }, { id: '2' }] });
    const page = await src.bootstrap({ page: null, snapshot: null, limit: 500 });
    expect(page.nextPage).toBeNull();
  });

  it('infers the next offset when configured for offset pagination', async () => {
    const { src } = source({ data: [{ id: '1' }, { id: '2' }] }, { pagination: 'offset' });
    const page = await src.bootstrap({ page: 10, snapshot: null, limit: 2 });
    expect(page.nextPage).toBe(12);
  });

  it('infers the next page number by default', async () => {
    const { src } = source({ data: [{ id: '1' }, { id: '2' }] });
    const page = await src.bootstrap({ page: 3, snapshot: null, limit: 2 });
    expect(page.nextPage).toBe(4);
  });

  it('honours an explicit null nextPage even when the page is full', async () => {
    const { src } = source({ data: [{ id: '1' }, { id: '2' }], nextPage: null });
    const page = await src.bootstrap({ page: 1, snapshot: null, limit: 2 });
    expect(page.nextPage).toBeNull();
  });
});

describe('createRestSource — delta', () => {
  it('does not advertise delta support unless configured', () => {
    const { src } = source({ data: [] });
    expect(src.delta).toBeUndefined();
  });
  it('reads changed rows, deleted keys and the next cursor', async () => {
    const { src, urls } = source({
      data: [{ id: '1', name: 'updated' }],
      deleted: ['9', 7],
      cursor: 'seq-9900',
      hasMore: false,
    }, { delta: true });
    const page = await src.delta!('seq-9812');

    expect(urls[0]).toContain('since=seq-9812');
    expect(page.changed).toHaveLength(1);
    // Keys are stringified: an origin with numeric ids must still line up with
    // deriveDocId, which hashes strings.
    expect(page.deleted).toEqual(['9', '7']);
    expect(page.cursor).toBe('seq-9900');
    expect(page.hasMore).toBe(false);
  });

  it('reports no deletions when the origin sends none', async () => {
    const { src } = source({ data: [], cursor: 'c' }, { delta: true });
    const page = await src.delta!('c0');
    expect(page.deleted).toEqual([]);
  });
});

describe('createRestSource — keys and mapping', () => {
  it('uses the configured key field', async () => {
    const { src } = source([], { key: 'sku' });
    expect(src.keyOf({ sku: 'ABC-1' } as never)).toBe('ABC-1');
  });

  it('stringifies a numeric key', async () => {
    const { src } = source([]);
    expect(src.keyOf({ id: 42 } as never)).toBe('42');
  });

  it('fails loudly when a row has no key', async () => {
    // Silently accepting this would mean every fetch of the row creates a *new*
    // document, and the replica grows duplicates forever.
    const { src } = source([]);
    expect(() => src.keyOf({ name: 'no key here' } as never)).toThrow(/no 'id' field/);
  });

  it('applies a projection via mapRow', async () => {
    const { src } = source([], {
      mapRow: (r: any) => ({ name: r.name, price: r.price }),
    });
    expect(src.mapRow({ id: '1', name: 'Mug', price: 300, description: 'long…' } as never)).toEqual({
      name: 'Mug',
      price: 300,
    });
  });

  it('drops a remote _id by default so it cannot fight the derived one', async () => {
    const { src } = source([]);
    expect(src.mapRow({ _id: 'theirs', id: '1', name: 'Mug' } as never)).toEqual({
      id: '1',
      name: 'Mug',
    });
  });
});

describe('createRestSource — auth', () => {
  it('resolves headers per request, not once at construction', async () => {
    // A background walk of 100k rows can outlive an access token. Baking the
    // header in at construction means the walk starts failing halfway through.
    let token = 'first';
    const m = mockFetch({ data: [] });
    const src = createRestSource({
      endpoint: '/api/products',
      collection: 'products',
      fetch: m.fetch,
      getAuth: () => ({ Authorization: `Bearer ${token}` }),
    });

    await src.bootstrap({ page: null, snapshot: null, limit: 10 });
    token = 'refreshed';
    await src.bootstrap({ page: 10, snapshot: null, limit: 10 });

    const calls = (m.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer first');
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer refreshed');
  });
});
