// Scoped-replication engine — the network half of `useQuery` / `useMutation`.
//
// Everything here is framework-agnostic (no React) so it can be unit-tested
// directly. The hooks are thin: they resolve config, then call `replicate`.
//
// Design decisions this file encodes (see docs/scoped-replication.md):
//   • Transport is the sync-contract (`HttpSyncAdapter` + `db.sync`), never raw
//     REST — so deletes/tombstones and Last-Write-Wins convergence come for free.
//   • Auth is resolved at *send time*, per pass, not baked into a long-lived
//     adapter — an offline write flushed later must carry a fresh token.
//   • Concurrent passes for the same (endpoint, collection, direction) are
//     de-duplicated, so two components asking for the same slice fire one sync.

import { HttpSyncAdapter, type SyncAdapter, type SyncDirection, type TalaDB } from 'taladb'

/** Resolved network configuration for one replicated slice. */
export interface ResolvedReplicationConfig {
  /** Base URL; `/push` and `/pull` are appended by {@link HttpSyncAdapter}. */
  endpoint: string
  /**
   * Async (or sync) resolver for per-request headers — typically the
   * `Authorization` bearer. Called **once per pass, at send time**, so a token
   * that refreshed while a write sat in the local database is picked up when the
   * write finally flushes.
   */
  getAuth?: () => Promise<Record<string, string>> | Record<string, string>
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Override the `/push` and `/pull` sub-paths to match an existing API. */
  paths?: { push?: string; pull?: string }
}

/**
 * Cursor-isolation / dedup target for one replicated slice. Endpoint-scoped so
 * the same collection replicated to two different origins keeps separate cursor
 * state and separate in-flight entries.
 */
export function replicationTarget(endpoint: string, collection: string): string {
  return `${endpoint}::${collection}`
}

/**
 * Build a fresh {@link SyncAdapter} with headers resolved *now*. A new adapter
 * per pass is cheap (it holds only config) and is what lets auth be resolved at
 * send time rather than at hook-mount time.
 */
export async function buildAdapter(config: ResolvedReplicationConfig): Promise<SyncAdapter> {
  const headers = config.getAuth ? await config.getAuth() : undefined
  return new HttpSyncAdapter({
    endpoint: config.endpoint,
    headers,
    fetch: config.fetch,
    paths: config.paths,
  })
}

// One in-flight pass per (endpoint, collection, direction). A second caller for
// the same key joins the existing promise instead of firing a duplicate sync.
const inflight = new Map<string, Promise<void>>()

function inflightKey(endpoint: string, collection: string, direction: SyncDirection): string {
  return `${endpoint}::${collection}::${direction}`
}

/**
 * Run one scoped sync pass for a single collection, de-duplicated against any
 * identical pass already running. Auth is resolved at send time.
 *
 * The pull half writes the pulled changeset into the local collection; the live
 * query (`useFind`) observing that collection then re-renders on its own — this
 * is the one-way data flow the design relies on. The network result is never
 * returned to the component here.
 */
export function replicate(
  db: TalaDB,
  config: ResolvedReplicationConfig,
  collection: string,
  direction: SyncDirection,
): Promise<void> {
  const key = inflightKey(config.endpoint, collection, direction)
  const existing = inflight.get(key)
  if (existing) return existing

  const pass = (async () => {
    const adapter = await buildAdapter(config)
    await db.sync(adapter, {
      collections: [collection],
      direction,
      target: replicationTarget(config.endpoint, collection),
    })
  })().finally(() => {
    inflight.delete(key)
  })

  inflight.set(key, pass)
  return pass
}

/** Per-request retry backoff, mirroring the Rust core's push retry (200/400/800 ms). */
const BACKOFFS_MS = [200, 400, 800]

/** Await a real delay; overridable in tests via {@link setSleep}. */
let sleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Test seam: replace the backoff sleep so retry paths run instantly. */
export function setSleep(fn: (ms: number) => Promise<void>): void {
  sleep = fn
}

/**
 * Replicate with bounded retry — used by the write path. On failure the local
 * write is **never** rolled back: it is already durably committed, and because
 * an export replays pending local changes, a later successful push (this pass's
 * retries, the next mutation, or a mount-time drain) still delivers it. Retry
 * only shortens the window; it does not own durability.
 *
 * Throws the last error after exhausting retries so the caller can surface it —
 * the change stays queued in the local database regardless.
 */
export async function replicateWithRetry(
  db: TalaDB,
  config: ResolvedReplicationConfig,
  collection: string,
  direction: SyncDirection,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      await replicate(db, config, collection, direction)
      return
    } catch (error) {
      lastError = error
      if (attempt < BACKOFFS_MS.length) await sleep(BACKOFFS_MS[attempt])
    }
  }
  throw lastError
}

/** Test-only: drop all in-flight dedup state between cases. */
export function __resetInflight(): void {
  inflight.clear()
}
