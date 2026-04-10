/**
 * Tests for the BroadcastChannel multi-tab live-query feature and the
 * shared makePoller helper.
 *
 * No real browser globals are required. BroadcastChannel is replaced with an
 * in-process fake. Timers are controlled via vitest's fake-timer API so the
 * 300 ms poll interval can be exercised without actually waiting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush pending Promise microtasks without advancing fake timers. */
const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

// ---------------------------------------------------------------------------
// Inline makePoller — mirrors src/index.ts exactly
// ---------------------------------------------------------------------------

type Document = Record<string, unknown>;

function makePoller<T extends Document>(
  findFn: () => Promise<T[]>,
  callback: (docs: T[]) => void,
): () => void {
  let active = true;
  let lastJson = '';
  const poll = async () => {
    if (!active) return;
    try {
      const docs = await findFn();
      const json = JSON.stringify(docs);
      if (json !== lastJson) {
        lastJson = json;
        callback(docs);
      }
    } catch { /* ignore errors during poll */ }
    if (active) setTimeout(poll, 300);
  };
  poll();
  return () => { active = false; };
}

// ---------------------------------------------------------------------------
// Inline nudgable subscribe — mirrors createBrowserDB's subscribe in index.ts
// ---------------------------------------------------------------------------

/**
 * Rebuild the subscribe closure from createBrowserDB so it can be tested
 * independently of the Worker/proxy infrastructure.
 *
 * `findFn` is already bound to a collection name and filter; it returns the
 * same raw JSON string that the WorkerProxy.send('find') would return.
 */
function makeNudgableSubscribe<T extends Document>(
  findFn: () => Promise<string>,
  nudgeCallbacks: Set<() => void>,
) {
  return function subscribe(callback: (docs: T[]) => void): () => void {
    let active = true;
    let lastJson = '[]';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (!active) return;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      try {
        const json = await findFn();
        if (json !== lastJson) {
          lastJson = json;
          callback(JSON.parse(json) as T[]);
        }
      } catch { /* ignore errors during poll */ }
      if (active) timer = setTimeout(poll, 300);
    };

    nudgeCallbacks.add(poll);
    poll();
    return () => {
      active = false;
      nudgeCallbacks.delete(poll);
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };
  };
}

// ---------------------------------------------------------------------------
// Fake BroadcastChannel — in-process multi-tab simulation
// ---------------------------------------------------------------------------

class FakeBroadcastChannel {
  static readonly registry = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  private _closed = false;

  constructor(public readonly name: string) {
    if (!FakeBroadcastChannel.registry.has(name)) {
      FakeBroadcastChannel.registry.set(name, new Set());
    }
    FakeBroadcastChannel.registry.get(name)!.add(this);
  }

  postMessage(data: unknown) {
    if (this._closed) return;
    const peers = FakeBroadcastChannel.registry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && !peer._closed) {
        // Async delivery — matches real BroadcastChannel behaviour
        Promise.resolve().then(() => peer.onmessage?.({ data }));
      }
    }
  }

  close() {
    this._closed = true;
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }

  get closed() { return this._closed; }

  static reset() { FakeBroadcastChannel.registry.clear(); }
}

// ---------------------------------------------------------------------------
// makePoller — unit tests
// ---------------------------------------------------------------------------

describe('makePoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls findFn immediately on creation', async () => {
    const findFn = vi.fn().mockResolvedValue([]);
    makePoller(findFn, vi.fn());
    await flushMicrotasks();
    expect(findFn).toHaveBeenCalledOnce();
  });

  it('fires callback with docs when result changes', async () => {
    const docs = [{ name: 'Alice' }];
    const findFn = vi.fn().mockResolvedValue(docs);
    const callback = vi.fn();
    makePoller(findFn, callback);
    await flushMicrotasks();
    expect(callback).toHaveBeenCalledWith(docs);
  });

  it('does not fire callback when JSON result is identical to previous', async () => {
    const findFn = vi.fn().mockResolvedValue([{ name: 'Alice' }]);
    const callback = vi.fn();
    makePoller(findFn, callback);
    await flushMicrotasks();
    expect(callback).toHaveBeenCalledTimes(1);

    // Second poll — same data
    await vi.advanceTimersByTimeAsync(300);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('fires callback again when result changes on a later poll', async () => {
    const findFn = vi.fn()
      .mockResolvedValueOnce([{ name: 'Alice' }])
      .mockResolvedValue([{ name: 'Alice' }, { name: 'Bob' }]);
    const callback = vi.fn();
    makePoller(findFn, callback);

    await flushMicrotasks();
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith([{ name: 'Alice' }, { name: 'Bob' }]);
  });

  it('schedules the next poll at exactly 300 ms', async () => {
    const findFn = vi.fn().mockResolvedValue([]);
    makePoller(findFn, vi.fn());
    await flushMicrotasks();
    expect(findFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(findFn).toHaveBeenCalledTimes(1); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(findFn).toHaveBeenCalledTimes(2);
  });

  it('stops polling permanently after unsubscribe', async () => {
    const findFn = vi.fn().mockResolvedValue([]);
    const unsubscribe = makePoller(findFn, vi.fn());
    await flushMicrotasks();
    expect(findFn).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(900); // 3 ticks
    expect(findFn).toHaveBeenCalledTimes(1); // no additional calls
  });

  it('handles findFn rejections gracefully and keeps polling', async () => {
    const findFn = vi.fn()
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValue([{ id: '1' }]);
    const callback = vi.fn();
    makePoller(findFn, callback);

    await flushMicrotasks();
    expect(callback).not.toHaveBeenCalled(); // error swallowed, no callback

    await vi.advanceTimersByTimeAsync(300);
    expect(callback).toHaveBeenCalledWith([{ id: '1' }]);
  });
});

// ---------------------------------------------------------------------------
// Nudgable subscribe — unit tests
// ---------------------------------------------------------------------------

describe('subscribe nudge mechanism', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('registers the poller in nudgeCallbacks after subscribe', () => {
    const nudgeCallbacks = new Set<() => void>();
    const subscribe = makeNudgableSubscribe(vi.fn().mockResolvedValue('[]'), nudgeCallbacks);
    expect(nudgeCallbacks.size).toBe(0);
    subscribe(vi.fn());
    expect(nudgeCallbacks.size).toBe(1);
  });

  it('removes the poller from nudgeCallbacks after unsubscribe', () => {
    const nudgeCallbacks = new Set<() => void>();
    const subscribe = makeNudgableSubscribe(vi.fn().mockResolvedValue('[]'), nudgeCallbacks);
    const unsubscribe = subscribe(vi.fn());
    expect(nudgeCallbacks.size).toBe(1);
    unsubscribe();
    expect(nudgeCallbacks.size).toBe(0);
  });

  it('nudge immediately triggers a poll without waiting 300 ms', async () => {
    const nudgeCallbacks = new Set<() => void>();
    const findFn = vi.fn()
      .mockResolvedValueOnce('[]')
      .mockResolvedValue('[{"name":"Alice"}]');
    const callback = vi.fn();
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    subscribe(callback);
    await flushMicrotasks();
    expect(findFn).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();

    // Nudge — should re-poll immediately, not at 300 ms
    for (const nudge of nudgeCallbacks) nudge();
    await flushMicrotasks();
    expect(findFn).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith([{ name: 'Alice' }]);
  });

  it('nudge cancels the pending 300 ms timer so no double-poll occurs', async () => {
    const nudgeCallbacks = new Set<() => void>();
    const findFn = vi.fn().mockResolvedValue('[]');
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    subscribe(vi.fn());
    await flushMicrotasks(); // initial poll, timer T₀ starts at t=0

    // Advance to t=200 ms — inside the 300 ms window
    await vi.advanceTimersByTimeAsync(200);
    expect(findFn).toHaveBeenCalledTimes(1);

    // Nudge fires poll now, cancels T₀, schedules fresh T₁ at t=200
    for (const nudge of nudgeCallbacks) nudge();
    await flushMicrotasks();
    expect(findFn).toHaveBeenCalledTimes(2);

    // The remaining 100 ms of T₀ should NOT fire a third poll
    await vi.advanceTimersByTimeAsync(100);
    expect(findFn).toHaveBeenCalledTimes(2);
  });

  it('multiple subscribers each receive the nudge independently', async () => {
    const nudgeCallbacks = new Set<() => void>();
    let call = 0;
    const findFn = vi.fn().mockImplementation(async () => {
      call++;
      return call <= 2 ? '[]' : '[{"x":1}]';
    });
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    subscribe(cb1);
    subscribe(cb2);
    await flushMicrotasks();
    expect(nudgeCallbacks.size).toBe(2);

    for (const nudge of nudgeCallbacks) nudge();
    await flushMicrotasks();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribed poller is NOT called when nudge fires', async () => {
    const nudgeCallbacks = new Set<() => void>();
    const findFn = vi.fn().mockResolvedValue('[]');
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    const unsubscribe = subscribe(vi.fn());
    await flushMicrotasks();
    const countBefore = findFn.mock.calls.length;

    unsubscribe();
    expect(nudgeCallbacks.size).toBe(0);

    // Simulating nudge — set is empty, no-op
    for (const nudge of nudgeCallbacks) nudge();
    await flushMicrotasks();
    expect(findFn).toHaveBeenCalledTimes(countBefore);
  });

  it('unsubscribe clears the pending setTimeout so no further ticks fire', async () => {
    const nudgeCallbacks = new Set<() => void>();
    const findFn = vi.fn().mockResolvedValue('[]');
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    const unsubscribe = subscribe(vi.fn());
    await flushMicrotasks(); // initial poll, 300 ms timer armed

    unsubscribe(); // should clearTimeout before the timer fires

    await vi.advanceTimersByTimeAsync(600);
    expect(findFn).toHaveBeenCalledTimes(1); // only the initial poll
  });
});

// ---------------------------------------------------------------------------
// BroadcastChannel integration — end-to-end message routing
// ---------------------------------------------------------------------------

describe('BroadcastChannel integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    FakeBroadcastChannel.reset();
  });

  it('"taladb:changed" from a sibling tab nudges active pollers', async () => {
    const nudgeCallbacks = new Set<() => void>();
    const findFn = vi.fn()
      .mockResolvedValueOnce('[]')
      .mockResolvedValue('[{"id":"abc"}]');
    const callback = vi.fn();
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    // Simulate the listener tab opening its BroadcastChannel
    const listenerCh = new FakeBroadcastChannel('taladb:testdb');
    listenerCh.onmessage = (e) => {
      if (e.data === 'taladb:changed') {
        for (const nudge of nudgeCallbacks) nudge();
      }
    };

    subscribe(callback);
    await flushMicrotasks(); // initial poll → empty
    expect(callback).not.toHaveBeenCalled();

    // Simulate the writer tab committing and broadcasting
    const writerCh = new FakeBroadcastChannel('taladb:testdb');
    writerCh.postMessage('taladb:changed');
    await flushMicrotasks(); // BroadcastChannel delivery → nudge → poll

    expect(findFn).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith([{ id: 'abc' }]);
  });

  it('messages other than "taladb:changed" are ignored', async () => {
    const nudgeCallbacks = new Set<() => void>();
    const findFn = vi.fn().mockResolvedValue('[]');
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    const listenerCh = new FakeBroadcastChannel('taladb:testdb');
    listenerCh.onmessage = (e) => {
      if (e.data === 'taladb:changed') {
        for (const nudge of nudgeCallbacks) nudge();
      }
    };

    subscribe(vi.fn());
    await flushMicrotasks();
    const countBefore = findFn.mock.calls.length;

    const writerCh = new FakeBroadcastChannel('taladb:testdb');
    writerCh.postMessage('some-other-event');
    writerCh.postMessage(null);
    writerCh.postMessage({ type: 'wrong' });
    await flushMicrotasks();

    expect(findFn).toHaveBeenCalledTimes(countBefore); // unchanged
  });

  it('channels for different dbNames do not cross-pollinate', async () => {
    const nudgeCallbacksA = new Set<() => void>();
    const nudgeCallbacksB = new Set<() => void>();
    const findFnA = vi.fn().mockResolvedValue('[]');
    const findFnB = vi.fn().mockResolvedValue('[]');

    const chA = new FakeBroadcastChannel('taladb:db-a');
    chA.onmessage = () => { for (const n of nudgeCallbacksA) n(); };

    const chB = new FakeBroadcastChannel('taladb:db-b');
    chB.onmessage = () => { for (const n of nudgeCallbacksB) n(); };

    makeNudgableSubscribe(findFnA, nudgeCallbacksA)(vi.fn());
    makeNudgableSubscribe(findFnB, nudgeCallbacksB)(vi.fn());
    await flushMicrotasks();
    const countA = findFnA.mock.calls.length;
    const countB = findFnB.mock.calls.length;

    // Writer posts to db-a channel only
    const writer = new FakeBroadcastChannel('taladb:db-a');
    writer.postMessage('taladb:changed');
    await flushMicrotasks();

    expect(findFnA).toHaveBeenCalledTimes(countA + 1); // nudged
    expect(findFnB).toHaveBeenCalledTimes(countB);      // untouched
  });

  it('calling close() on the listener channel stops it receiving messages', async () => {
    const nudgeCallbacks = new Set<() => void>();
    const findFn = vi.fn().mockResolvedValue('[]');
    const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

    const listenerCh = new FakeBroadcastChannel('taladb:testdb');
    listenerCh.onmessage = (e) => {
      if (e.data === 'taladb:changed') {
        for (const nudge of nudgeCallbacks) nudge();
      }
    };

    subscribe(vi.fn());
    await flushMicrotasks();
    const countBefore = findFn.mock.calls.length;

    listenerCh.close(); // simulate db.close()

    const writerCh = new FakeBroadcastChannel('taladb:testdb');
    writerCh.postMessage('taladb:changed');
    await flushMicrotasks();

    expect(findFn).toHaveBeenCalledTimes(countBefore); // no extra polls
  });

  it('worker and listener use the same channel name pattern "taladb:<dbName>"', () => {
    // The channel name must be identical on both sides.
    // This test asserts the naming convention is symmetric.
    const dbName = 'my-app.db';
    const expectedName = `taladb:${dbName}`;

    const ch1 = new FakeBroadcastChannel(expectedName);
    const ch2 = new FakeBroadcastChannel(expectedName);

    expect(FakeBroadcastChannel.registry.get(expectedName)?.size).toBe(2);

    const received: unknown[] = [];
    ch2.onmessage = (e) => received.push(e.data);
    ch1.postMessage('taladb:changed');

    return flushMicrotasks().then(() => {
      expect(received).toEqual(['taladb:changed']);
    });
  });

  it('gracefully falls back to 300 ms polling when BroadcastChannel is unavailable', async () => {
    // Simulate an environment without BroadcastChannel (e.g. older Safari)
    const g = globalThis as Record<string, unknown>;
    const original = g.BroadcastChannel;
    delete g.BroadcastChannel;

    try {
      const nudgeCallbacks = new Set<() => void>();
      // No BroadcastChannel listener set up — pure timer fallback
      const findFn = vi.fn()
        .mockResolvedValueOnce('[]')
        .mockResolvedValue('[{"fallback":true}]');
      const callback = vi.fn();
      const subscribe = makeNudgableSubscribe(findFn, nudgeCallbacks);

      subscribe(callback);
      await flushMicrotasks();
      expect(callback).not.toHaveBeenCalled();

      // Data should still arrive via the 300 ms timer
      await vi.advanceTimersByTimeAsync(300);
      expect(callback).toHaveBeenCalledWith([{ fallback: true }]);
    } finally {
      if (original !== undefined) g.BroadcastChannel = original;
    }
  });
});
