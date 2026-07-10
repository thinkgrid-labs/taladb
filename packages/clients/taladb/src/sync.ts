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
  /** Sync target name; the document `_id`. */
  _id: string;
  /** Millisecond-epoch watermark: changes at or before this are already synced. */
  sinceMs: number;
}

/** The low-level surface `runSync` needs from a platform DB handle. */
export interface SyncHandle {
  exportChanges(collections: string[], sinceMs: number): Promise<SerializedChangeset>;
  importChanges(changeset: SerializedChangeset): Promise<number>;
  collection(name: string): Collection<CursorDoc>;
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

async function readCursor(cursorCol: Collection<CursorDoc>, target: string): Promise<number> {
  const doc = await cursorCol.findOne({ _id: target } as never);
  return doc?.sinceMs ?? 0;
}

async function writeCursor(
  cursorCol: Collection<CursorDoc>,
  target: string,
  sinceMs: number,
): Promise<void> {
  const existing = await cursorCol.findOne({ _id: target } as never);
  if (existing) {
    await cursorCol.updateOne({ _id: target } as never, { $set: { sinceMs } } as never);
  } else {
    await cursorCol.insert({ _id: target, sinceMs } as never);
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
 * The cursor is captured before the export scan and advanced to that value, so
 * a write racing the scan is simply re-synced next pass — harmless because
 * `importChanges` is idempotent under LWW.
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

  const cursorCol = handle.collection(CURSOR_COLLECTION);
  const sinceMs = await readCursor(cursorCol, target);
  const startedAt = Date.now();

  // Snapshot local changes before importing anything, so pulled changes aren't
  // pushed back to the peer they came from.
  const local = doPush ? await handle.exportChanges(options.collections, sinceMs) : '[]';

  let pulled = 0;
  if (doPull) {
    const remote = await adapter.pull!(sinceMs);
    if (remote && remote !== '[]') {
      pulled = await handle.importChanges(remote);
    }
  }

  let pushed = 0;
  if (doPush && local !== '[]') {
    pushed = (JSON.parse(local) as unknown[]).length;
    await adapter.push!(local);
  }

  await writeCursor(cursorCol, target, startedAt);
  return { pushed, pulled, cursor: startedAt };
}
