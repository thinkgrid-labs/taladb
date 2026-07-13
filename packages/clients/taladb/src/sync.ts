// TalaDB bidirectional sync orchestration.
//
// Runtime-agnostic: `runSync` depends only on the low-level exportChanges /
// importChanges primitives (exposed by every platform binding) plus a
// collection handle for cursor persistence — so the same loop drives sync on
// Node.js, browser (WASM), and React Native.

import type {
  Collection,
  CursorSyncAdapter,
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
  /** Legacy field, retained so old cursor documents still deserialize. */
  pullMs: number;
  /**
   * Opaque pull cursor, issued by the origin via
   * {@link import('./types').CursorSyncAdapter.pullWithCursor}. Absent for
   * timestamp-only adapters, which replay from zero every pass.
   *
   * **Never parsed.** Its meaning belongs to the origin — a sequence, an LSN, a
   * timestamp, a snapshot id. Interpreting it here is how the clock-skew bug
   * comes back.
   */
  pullCursor?: string;
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
   * (Node.js, browser, and React Native as of 0.9.2). `schemasJson` is a
   * JSON-encoded `Record<string, SyncSchema>`. When absent — an older native
   * module — `runSync` falls back to the unvalidated {@link importChanges}.
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
  pullCursor?: string;
}

async function readCursor(cursorCol: Collection<CursorDoc>, target: string): Promise<Cursor> {
  const doc = await cursorCol.findOne({ target } as never);
  return {
    pushMs: doc?.pushMs ?? 0,
    pullMs: doc?.pullMs ?? 0,
    pullCursor: doc?.pullCursor,
  };
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

/** An adapter is cursor-capable when it implements `pullWithCursor`. */
function isCursorAdapter(adapter: SyncAdapter): adapter is CursorSyncAdapter {
  return typeof (adapter as CursorSyncAdapter).pullWithCursor === 'function';
}

/** Guard against a misbehaving origin looping us forever on `hasMore: true`. */
const MAX_PULL_PAGES = 10_000;

/**
 * Run one sync pass.
 *
 * The local changeset is snapshotted *before* the remote pull is imported, so a
 * change just pulled from the remote is never echoed straight back on the same
 * pass — push carries only genuinely-local changes. Order of import vs. push
 * doesn't affect convergence: Last-Write-Wins resolves by `changed_at`, so both
 * sides reach the same state regardless.
 *
 * ## Pull cursors
 *
 * Two paths, chosen by feature-detection:
 *
 * - **{@link CursorSyncAdapter}** (`pullWithCursor`) — the origin issues an opaque
 *   resume token, which we persist and hand straight back. Pages are drained until
 *   `hasMore` is false. This is the path that makes an incremental refresh of a
 *   large replica affordable.
 * - **Plain {@link SyncAdapter}** (`pull(sinceMs)`) — replays from zero every pass.
 *   Not laziness: author wall-clock timestamps are *not* safe cursors, because a
 *   write can commit after an export yet carry an earlier timestamp, so resuming
 *   from "the newest timestamp I saw" silently drops rows. Replaying everything is
 *   idempotent under LWW — it trades bandwidth for never skipping data.
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
  // Either pull contract satisfies a pull: `pullWithCursor` (preferred) or the
  // legacy timestamp `pull`. An adapter implementing only the former is complete.
  if (doPull && !adapter.pull && !isCursorAdapter(adapter)) {
    throw new Error(
      `sync direction '${direction}' requires adapter.pull() or adapter.pullWithCursor()`,
    );
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
  let pullCursor = cursor.pullCursor;

  /** Import one changeset, honouring the tolerant validator when one applies. */
  async function importOne(changeset: SerializedChangeset): Promise<void> {
    if (!changeset || changeset === '[]') return;
    if (useValidated) {
      const report = await handle.importChangesValidated!(changeset, JSON.stringify(scopedSchemas));
      pulled += report.applied;
      skipped += report.skipped;
      quarantined += report.quarantined;
    } else {
      pulled += await handle.importChanges(changeset);
    }
  }

  if (doPull) {
    if (isCursorAdapter(adapter)) {
      // Cursor-capable origin: resume from the stored opaque token and drain the
      // pages it offers. The cursor advances only after each page is durably
      // imported, so an interruption re-fetches at most one page rather than
      // skipping it — the safe direction to fail in.
      let pages = 0;
      for (;;) {
        const result = await adapter.pullWithCursor(pullCursor ?? null);
        await importOne(result.changeset);
        pullCursor = result.cursor;
        await writeCursor(cursorCol, target, { ...cursor, pullCursor });
        if (!result.hasMore) break;
        if (++pages >= MAX_PULL_PAGES) {
          throw new Error(
            `sync: origin returned hasMore after ${MAX_PULL_PAGES} pages for target ` +
              `'${target}' — it is probably not advancing its cursor.`,
          );
        }
      }
    } else {
      // Timestamp-only adapter: no safe cursor exists, so replay from zero. Import
      // is idempotent under Last-Write-Wins, trading bandwidth for no skipped data.
      await importOne(await adapter.pull!(0));
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
    ...(pullCursor !== undefined ? { pullCursor } : {}),
  });
  return { pushed, pulled, skipped, quarantined, cursor: 0 };
}
