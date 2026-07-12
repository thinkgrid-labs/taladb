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
  SyncSchema,
} from './types';

/** Reserved collection holding one cursor document per sync target. Hidden
 * from `listCollectionNames` (the core filters `_`-prefixed collections) and
 * never itself synced. */
const CURSOR_COLLECTION = '__taladb_sync';

interface CursorDoc extends Document {
  /** Sync target name. A plain field, NOT `_id`: the engine assigns ULIDs and
   * ignores caller-supplied ids, so a custom `_id` would never match again. */
  target: string;
  /** Reserved for a future storage-level monotonic export cursor. */
  pushMs: number;
  /** Reserved for a future server-issued opaque cursor. */
  pullMs: number;
}

/** Outcome of a validated import: applied/skipped/quarantined counts. */
export interface ImportReport {
  applied: number;
  skipped: number;
  quarantined: number;
}

/** The low-level surface `runSync` needs from a platform DB handle. */
export interface SyncHandle {
  exportChanges(collections: string[], sinceMs: number): Promise<SerializedChangeset>;
  importChanges(changeset: SerializedChangeset): Promise<number>;
  /**
   * Tolerant validated import — present only on bindings that support it
   * (Node.js today). `schemasJson` is a JSON-encoded
   * `Record<string, SyncSchema>`. When absent, `runSync` falls back to the
   * unvalidated {@link importChanges}.
   */
  importChangesValidated?(
    changeset: SerializedChangeset,
    schemasJson: string,
  ): Promise<ImportReport>;
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
 * The current adapter contract only exposes author wall-clock timestamps. Such
 * timestamps are not safe cursors: a write can commit after an export with an
 * earlier timestamp, and a remote event can arrive late. Until adapters expose
 * storage/server-issued monotonic cursors, each pass therefore replays from
 * zero. Import is idempotent under LWW, trading bandwidth for no skipped data.
 */
export async function runSync(
  handle: SyncHandle,
  adapter: SyncAdapter,
  options: SyncOptions,
  syncSchemas: Record<string, SyncSchema> = {},
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
  // Snapshot local changes before importing anything, so pulled changes aren't
  // pushed back to the peer they came from.
  const local = doPush ? await handle.exportChanges(collections, 0) : '[]';

  // Only the collections actually in scope for this pass need a schema; a peer
  // that sends others still merges under plain LWW.
  const scopedSchemas: Record<string, SyncSchema> = {};
  for (const c of collections) {
    if (syncSchemas[c]) scopedSchemas[c] = syncSchemas[c];
  }
  const useValidated = handle.importChangesValidated && Object.keys(scopedSchemas).length > 0;

  let pulled = 0;
  let skipped = 0;
  let quarantined = 0;
  if (doPull) {
    const remote = await adapter.pull!(0);
    if (remote && remote !== '[]') {
      if (useValidated) {
        const report = await handle.importChangesValidated!(remote, JSON.stringify(scopedSchemas));
        pulled = report.applied;
        skipped = report.skipped;
        quarantined = report.quarantined;
      } else {
        pulled = await handle.importChanges(remote);
      }
    }
  }

  let pushed = 0;
  if (doPush && local !== '[]') {
    pushed = (JSON.parse(local) as unknown[]).length;
    await adapter.push!(local);
  }

  await writeCursor(cursorCol, target, {
    pushMs: cursor.pushMs,
    pullMs: cursor.pullMs,
  });
  return { pushed, pulled, skipped, quarantined, cursor: 0 };
}
