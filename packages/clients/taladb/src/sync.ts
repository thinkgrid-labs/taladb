// TalaDB bidirectional sync orchestration.
//
// Runtime-agnostic: `runSync` depends only on the low-level exportChanges /
// importChanges primitives (exposed by every platform binding) plus a
// collection handle for cursor persistence — so the same loop drives sync on
// Node.js, browser (WASM), and React Native.

import type {
  Collection,
  Document,
  SerializedChangeset,
  SyncAdapter,
  SyncOptions,
  SyncResult,
} from './types';

/** Reserved collection holding one cursor document per sync target. Hidden
 * from `listCollectionNames` (the core filters `_`-prefixed collections) and
 * never itself synced. */
const CURSOR_COLLECTION = '__taladb_sync';

interface CursorDoc extends Document {
  /** Sync target name. A plain field, NOT `_id`: the engine assigns ULIDs and
   * ignores caller-supplied ids, so a custom `_id` would never match again. */
  target: string;
  /** LOCAL watermark for exports: local changes stamped at or before this have
   * already been pushed. Local writes are stamped by the same clock, so a
   * wall-clock watermark is sound here. */
  pushMs: number;
  /** REMOTE watermark for pulls: the highest `changed_at` among changes
   * received so far. Deliberately NOT the local clock — a remote change is
   * authored on another device's clock and may arrive at the server after we
   * last synced; filtering remote changes by our local time would skip it
   * forever. Advancing only past what we have actually received keeps every
   * late-arriving change fetchable. */
  pullMs: number;
}

/** The low-level surface `runSync` needs from a platform DB handle. */
export interface SyncHandle {
  exportChanges(collections: string[], sinceMs: number): Promise<SerializedChangeset>;
  importChanges(changeset: SerializedChangeset): Promise<number>;
  collection(name: string): Collection<CursorDoc>;
  /** User collection names (reserved `_`-prefixed excluded). Backs "sync all". */
  listCollectionNames(): Promise<string[]>;
}

/**
 * Resolve which collections a sync pass covers: the explicit `collections` list
 * or, when omitted, every user collection — then minus `exclude` and any
 * reserved `_`-prefixed name (the cursor store must never sync).
 */
async function resolveCollections(handle: SyncHandle, options: SyncOptions): Promise<string[]> {
  const base = options.collections ?? (await handle.listCollectionNames());
  const excluded = new Set(options.exclude ?? []);
  return base.filter((c) => !excluded.has(c) && !c.startsWith('_'));
}

/**
 * Sync surface for runtimes whose binding isn't wired for sync yet (browser
 * OPFS-worker and React Native). The core engine supports sync on all three
 * runtimes; only the binding plumbing is pending. Node.js is fully wired today.
 * Returns the `{ sync, exportChanges, importChanges }` slice, each throwing a
 * clear error, so the unified `TalaDB` type is satisfied uniformly.
 */
export function unsupportedSync(runtime: string): Pick<
  import('./types').TalaDB,
  'sync' | 'exportChanges' | 'importChanges'
> {
  const err = () =>
    new Error(
      `TalaDB sync is not yet available on the ${runtime} runtime (Node.js is supported today; ` +
        `browser and React Native are in progress). Track it on the roadmap.`,
    );
  return {
    sync: () => Promise.reject(err()),
    exportChanges: () => Promise.reject(err()),
    importChanges: () => Promise.reject(err()),
  };
}

interface Cursor {
  pushMs: number;
  pullMs: number;
}

async function readCursor(cursorCol: Collection<CursorDoc>, target: string): Promise<Cursor> {
  const doc = await cursorCol.findOne({ target } as never);
  return { pushMs: doc?.pushMs ?? 0, pullMs: doc?.pullMs ?? 0 };
}

async function writeCursor(
  cursorCol: Collection<CursorDoc>,
  target: string,
  cursor: Cursor,
): Promise<void> {
  const updated = await cursorCol.updateOne({ target } as never, { $set: { ...cursor } } as never);
  if (!updated) {
    await cursorCol.insert({ target, ...cursor } as never);
  }
}

/**
 * Run one sync pass.
 *
 * The local changeset is snapshotted *before* the remote pull is imported, so a
 * change just pulled from the remote is never echoed straight back on the same
 * pass — push carries only genuinely-local changes. Order of import vs. push
 * doesn't affect convergence: Last-Write-Wins resolves by `changed_at`, so both
 * sides reach the same state regardless.
 *
 * Two independent watermarks per target: `pushMs` (local clock, captured before
 * the export scan — a write racing the scan is simply re-synced next pass,
 * harmless because `importChanges` is idempotent under LWW) and `pullMs` (the
 * newest remote `changed_at` actually received, so a change that reaches the
 * server after our pass but was authored earlier is still fetched next time).
 */
export async function runSync(
  handle: SyncHandle,
  adapter: SyncAdapter,
  options: SyncOptions,
): Promise<SyncResult> {
  const direction = options.direction ?? 'both';
  const target = options.target ?? 'default';
  const doPush = direction === 'push' || direction === 'both';
  const doPull = direction === 'pull' || direction === 'both';
  if (doPull && !adapter.pull) {
    throw new Error(`sync direction '${direction}' requires adapter.pull()`);
  }
  if (doPush && !adapter.push) {
    throw new Error(`sync direction '${direction}' requires adapter.push()`);
  }

  const collections = await resolveCollections(handle, options);
  const cursorCol = handle.collection(CURSOR_COLLECTION);
  const cursor = await readCursor(cursorCol, target);
  const startedAt = Date.now();

  // Snapshot local changes before importing anything, so pulled changes aren't
  // pushed back to the peer they came from.
  const local = doPush ? await handle.exportChanges(collections, cursor.pushMs) : '[]';

  let pulled = 0;
  let pullMs = cursor.pullMs;
  if (doPull) {
    const remote = await adapter.pull!(cursor.pullMs);
    if (remote && remote !== '[]') {
      pulled = await handle.importChanges(remote);
      // Advance the pull watermark to the newest change actually received —
      // never to the local clock (see CursorDoc.pullMs).
      for (const c of JSON.parse(remote) as { changed_at?: number }[]) {
        if (typeof c.changed_at === 'number' && c.changed_at > pullMs) pullMs = c.changed_at;
      }
    }
  }

  let pushed = 0;
  if (doPush && local !== '[]') {
    pushed = (JSON.parse(local) as unknown[]).length;
    await adapter.push!(local);
  }

  await writeCursor(cursorCol, target, {
    pushMs: doPush ? startedAt : cursor.pushMs,
    pullMs,
  });
  return { pushed, pulled, cursor: startedAt };
}
