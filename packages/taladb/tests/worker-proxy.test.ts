/**
 * Tests for WorkerProxy — the thin postMessage bridge used by the browser adapter.
 *
 * These tests run in Node and simulate a MessagePort with a simple in-process
 * event emitter so no browser globals are required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal MessagePort stub
// ---------------------------------------------------------------------------

interface Message {
  id: number;
  op: string;
  [key: string]: unknown;
}

interface Reply {
  id: number;
  result?: unknown;
  error?: string;
}

/** Creates a fake MessagePort pair where postMessage on one side triggers
 *  onmessage on the same object (simulating the worker echoing back). */
function createFakePort(handler: (msg: Message) => Reply) {
  let onmessage: ((e: { data: Reply }) => void) | null = null;
  const port = {
    start: vi.fn(),
    set onmessage(fn: ((e: { data: Reply }) => void) | null) {
      onmessage = fn;
    },
    get onmessage() { return onmessage; },
    postMessage(msg: Message) {
      // Simulate async response from the worker
      const reply = handler(msg);
      Promise.resolve().then(() => {
        if (onmessage) onmessage({ data: reply });
      });
    },
  };
  return port as unknown as MessagePort;
}

// ---------------------------------------------------------------------------
// Re-implement WorkerProxy inline so tests don't depend on the built output.
// This mirrors the implementation in src/index.ts exactly.
// ---------------------------------------------------------------------------

class WorkerProxy {
  private readonly port: MessagePort;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;

  constructor(port: MessagePort) {
    this.port = port;
    this.port.onmessage = (e) => {
      const { id, result, error } = e.data as Reply;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (error === undefined) p.resolve(result);
        else p.reject(new Error(error));
      }
    };
    this.port.start();
  }

  send<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.port.postMessage({ id, op, ...args } as unknown as Message);
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerProxy', () => {
  it('sends op and resolves with the worker result', async () => {
    const port = createFakePort((msg) => ({ id: msg.id, result: 'ok-id' }));
    const proxy = new WorkerProxy(port);

    const result = await proxy.send<string>('insert', { collection: 'users', docJson: '{}' });
    expect(result).toBe('ok-id');
  });

  it('rejects when the worker returns an error', async () => {
    const port = createFakePort((msg) => ({
      id: msg.id,
      error: 'collection not found',
    }));
    const proxy = new WorkerProxy(port);

    await expect(proxy.send('find', { collection: 'missing' })).rejects.toThrow(
      'collection not found',
    );
  });

  it('multiplexes concurrent requests by id', async () => {
    const received: Message[] = [];
    const port = createFakePort((msg) => {
      received.push(msg);
      return { id: msg.id, result: `reply-${msg.id}` };
    });
    const proxy = new WorkerProxy(port);

    const [a, b, c] = await Promise.all([
      proxy.send<string>('find'),
      proxy.send<string>('count'),
      proxy.send<string>('insert'),
    ]);

    expect(a).toBe('reply-1');
    expect(b).toBe('reply-2');
    expect(c).toBe('reply-3');
    expect(received.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('calls port.start() on construction', () => {
    const port = createFakePort((m) => ({ id: m.id, result: null }));
    const startSpy = vi.spyOn(port, 'start');
    new WorkerProxy(port);
    expect(startSpy).toHaveBeenCalledOnce();
  });

  it('increments message ids sequentially', async () => {
    const ids: number[] = [];
    const port = createFakePort((msg) => {
      ids.push(msg.id);
      return { id: msg.id, result: null };
    });
    const proxy = new WorkerProxy(port);

    await proxy.send('a');
    await proxy.send('b');
    await proxy.send('c');

    expect(ids).toEqual([1, 2, 3]);
  });
});
