import { describe, expect, it } from 'vitest';
import { runSync, type SyncHandle } from '../src/sync';
import type { CursorSyncAdapter, PullResult, SyncAdapter } from '../src/types';

/**
 * `pullWithCursor` — the opaque, origin-issued resume cursor.
 *
 * The point of the whole thing: `pull(sinceMs)` cannot be made correct, because a
 * write can commit *after* an export yet carry an *earlier* wall-clock timestamp.
 * TalaDB's response was to replay from zero on every pass — safe, but it
 * re-downloads the entire collection forever, which is what makes a full local
 * replica of a real catalog unaffordable. Letting the origin issue the token, and
 * never parsing it on the client, sidesteps the clock entirely.
 */

interface Row {
  id: string;
  changed_at: number;
  body: string;
  collection: string;
}

/** Minimal SyncHandle: enough LWW to make the orchestration honest. */
class MemHandle implements SyncHandle {
  rows = new Map<string, Row>();
  cursors = new Map<string, Record<string, unknown>>();

  exportChanges = async (collections: string[], sinceMs: number): Promise<string> => {
    const include = new Set(collections);
    return JSON.stringify(
      [...this.rows.values()]
        .filter((r) => r.changed_at > sinceMs && include.has(r.collection))
        .map((r) => ({
          collection: r.collection,
          id: r.id,
          op: { Upsert: { body: r.body } },
          changed_at: r.changed_at,
        })),
    );
  };

  importChanges = async (changeset: string): Promise<number> => {
    const changes = JSON.parse(changeset) as {
      collection: string;
      id: string;
      changed_at: number;
      op: { Upsert: { body: string } };
    }[];
    let applied = 0;
    for (const c of changes) {
      const existing = this.rows.get(c.id);
      if (!existing || c.changed_at > existing.changed_at) {
        this.rows.set(c.id, {
          id: c.id,
          changed_at: c.changed_at,
          body: c.op.Upsert.body,
          collection: c.collection,
        });
        applied++;
      }
    }
    return applied;
  };

  listCollectionNames = async (): Promise<string[]> => ['notes'];

  collection = (_name: string): never => {
    const cursors = this.cursors;
    return {
      findOne: async (f: { target: string }) => cursors.get(f.target) ?? null,
      insert: async (doc: Record<string, unknown>) => {
        cursors.set(doc.target as string, { ...doc });
        return 'cursor-id';
      },
      updateOne: async (f: { target: string }, u: { $set: Record<string, unknown> }) => {
        const existing = cursors.get(f.target);
        if (!existing) return false;
        Object.assign(existing, u.$set);
        return true;
      },
    } as never;
  };
}

function change(id: string, body: string, changed_at: number) {
  return { collection: 'notes', id, op: { Upsert: { body } }, changed_at };
}

/**
 * A paged origin. Each page is one row; the cursor is the page index, as an
 * opaque string the client must not interpret.
 */
function pagedOrigin(pages: string[][]) {
  const calls: Array<string | null> = [];
  const adapter: CursorSyncAdapter = {
    push: async () => {},
    pullWithCursor: async (cursor): Promise<PullResult> => {
      calls.push(cursor);
      const index = cursor === null ? 0 : Number(cursor);
      const rows = pages[index] ?? [];
      return {
        changeset: JSON.stringify(rows.map((id, i) => change(id, id, (index + 1) * 100 + i))),
        cursor: String(index + 1),
        hasMore: index + 1 < pages.length,
      };
    },
  };
  return { adapter, calls };
}

describe('runSync with a cursor-capable adapter', () => {
  it('drains every page and imports them all', async () => {
    const handle = new MemHandle();
    const { adapter, calls } = pagedOrigin([['a'], ['b'], ['c']]);

    const result = await runSync(handle, adapter, { collections: ['notes'], direction: 'pull' });

    expect(result.pulled).toBe(3);
    expect([...handle.rows.keys()].sort()).toEqual(['a', 'b', 'c']);
    // Started from nothing, then followed the origin's tokens.
    expect(calls).toEqual([null, '1', '2']);
  });

  it('resumes from the persisted cursor on the next pass, not from zero', async () => {
    // This is the whole feature: pass 2 must not re-download pass 1's pages.
    const handle = new MemHandle();
    const { adapter, calls } = pagedOrigin([['a'], ['b']]);

    await runSync(handle, adapter, { collections: ['notes'], direction: 'pull' });
    calls.length = 0;
    await runSync(handle, adapter, { collections: ['notes'], direction: 'pull' });

    expect(calls[0], 'the second pass must resume from the stored token').toBe('2');
    expect(calls).not.toContain(null);
  });

  it('persists the cursor as an opaque string and never parses it', async () => {
    const handle = new MemHandle();
    const adapter: CursorSyncAdapter = {
      pullWithCursor: async () => ({
        changeset: '[]',
        // Deliberately not a number. A client that tried to interpret this — or
        // coerce it — would break here.
        cursor: 'seq:9812@snapshot-abc',
        hasMore: false,
      }),
    };

    await runSync(handle, adapter, { collections: ['notes'], direction: 'pull' });

    expect(handle.cursors.get('default')?.pullCursor).toBe('seq:9812@snapshot-abc');
  });

  it('advances the cursor only after a page is imported', async () => {
    // If the origin fails mid-drain, we must re-fetch the failed page rather than
    // skip it — the safe direction to fail in.
    const handle = new MemHandle();
    let call = 0;
    const adapter: CursorSyncAdapter = {
      pullWithCursor: async (cursor) => {
        call++;
        if (call === 1) {
          return { changeset: JSON.stringify([change('a', 'a', 100)]), cursor: '1', hasMore: true };
        }
        throw new Error('origin exploded');
        void cursor;
      },
    };

    await expect(
      runSync(handle, adapter, { collections: ['notes'], direction: 'pull' }),
    ).rejects.toThrow('origin exploded');

    // Page 1 landed and its cursor was committed; page 2 will be retried.
    expect(handle.rows.has('a')).toBe(true);
    expect(handle.cursors.get('default')?.pullCursor).toBe('1');
  });

  it('refuses to loop forever when an origin never advances', async () => {
    const handle = new MemHandle();
    const adapter: CursorSyncAdapter = {
      pullWithCursor: async () => ({ changeset: '[]', cursor: 'stuck', hasMore: true }),
    };

    await expect(
      runSync(handle, adapter, { collections: ['notes'], direction: 'pull' }),
    ).rejects.toThrow(/not advancing its cursor/);
  });
});

describe('runSync with a legacy timestamp-only adapter', () => {
  it('still replays from zero, unchanged', async () => {
    // The additive-contract guarantee: existing adapters must not shift behavior.
    const handle = new MemHandle();
    const sinceCalls: number[] = [];
    const adapter: SyncAdapter = {
      pull: async (sinceMs) => {
        sinceCalls.push(sinceMs);
        return JSON.stringify([change('a', 'a', 100)]);
      },
    };

    await runSync(handle, adapter, { collections: ['notes'], direction: 'pull' });
    await runSync(handle, adapter, { collections: ['notes'], direction: 'pull' });

    expect(sinceCalls, 'a timestamp-only adapter has no safe cursor to resume from').toEqual([0, 0]);
    expect(handle.rows.has('a')).toBe(true);
    // And it stores no pull cursor, so it can't be mistaken for a cursor adapter.
    expect(handle.cursors.get('default')?.pullCursor).toBeUndefined();
  });
});
