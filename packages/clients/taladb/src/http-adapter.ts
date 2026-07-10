// Reference bidirectional HTTP sync adapter.
//
// Implements SyncAdapter over a minimal REST contract, so any backend can be a
// sync peer with two endpoints:
//
//   POST  {endpoint}/push       body = serialized changeset (JSON)   → 2xx
//   GET   {endpoint}/pull?since={ms}                                 → serialized changeset (JSON)
//
// `push` sends local changes; `pull` returns remote changes with `changed_at`
// after `since`. The changeset is an opaque JSON string produced/consumed by
// TalaDB — the server stores and range-queries it however it likes.

import type { SerializedChangeset, SyncAdapter } from './types';

export interface HttpSyncAdapterOptions {
  /** Base URL, e.g. `https://api.example.com/sync`. `/push` and `/pull` are appended. */
  endpoint: string;
  /** Extra headers on every request — typically `Authorization`. */
  headers?: Record<string, string>;
  /**
   * `fetch` implementation. Defaults to the global `fetch` (Node 18+, browsers,
   * React Native). Inject a custom one for tests or non-standard environments.
   */
  fetch?: typeof fetch;
  /** Paths appended to `endpoint`. Override to match an existing API. */
  paths?: { push?: string; pull?: string };
}

/**
 * A ready-to-use {@link SyncAdapter} that syncs over plain HTTP. Pair it with
 * {@link TalaDB.sync}:
 *
 * ```ts
 * const adapter = new HttpSyncAdapter({
 *   endpoint: 'https://api.example.com/sync',
 *   headers: { Authorization: `Bearer ${token}` },
 * });
 * await db.sync(adapter, { collections: ['notes'] });
 * ```
 */
export class HttpSyncAdapter implements SyncAdapter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;
  private readonly pushPath: string;
  private readonly pullPath: string;

  constructor(options: HttpSyncAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.headers = options.headers ?? {};
    const f = options.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error(
        'HttpSyncAdapter: no fetch available. Pass options.fetch on runtimes without a global fetch.',
      );
    }
    this.fetchFn = f;
    this.pushPath = options.paths?.push ?? '/push';
    this.pullPath = options.paths?.pull ?? '/pull';
  }

  async push(changeset: SerializedChangeset): Promise<void> {
    const res = await this.fetchFn(`${this.endpoint}${this.pushPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: changeset,
    });
    if (!res.ok) {
      throw new Error(`HttpSyncAdapter push failed: ${res.status} ${res.statusText}`);
    }
  }

  async pull(sinceMs: number): Promise<SerializedChangeset> {
    const url = `${this.endpoint}${this.pullPath}?since=${encodeURIComponent(String(sinceMs))}`;
    const res = await this.fetchFn(url, { method: 'GET', headers: this.headers });
    if (!res.ok) {
      throw new Error(`HttpSyncAdapter pull failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.text()).trim();
    // Tolerate an empty body as "nothing new".
    return body.length === 0 ? '[]' : body;
  }
}
