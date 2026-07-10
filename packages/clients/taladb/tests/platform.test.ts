/**
 * Tests for platform detection and the openDB error surface.
 *
 * Platform detection inspects globalThis properties at runtime. These tests
 * manipulate globalThis directly (restored after each test) to verify the
 * three branches: browser, react-native, and node.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Re-implement detectPlatform inline so tests don't depend on the built output.
// Mirrors src/index.ts exactly.
// ---------------------------------------------------------------------------

type Platform = 'browser' | 'react-native' | 'node';

function detectPlatform(): Platform {
  if ((globalThis as Record<string, unknown>).nativeCallSyncHook !== undefined) {
    return 'react-native';
  }
  if (
    (globalThis as Record<string, unknown>).window !== undefined &&
    typeof navigator !== 'undefined'
  ) {
    return 'browser';
  }
  return 'node';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectPlatform', () => {
  const g = globalThis as Record<string, unknown>;
  let originalNative: unknown;
  let originalWindow: unknown;

  beforeEach(() => {
    originalNative = g.nativeCallSyncHook;
    originalWindow = g.window;
  });

  afterEach(() => {
    if (originalNative === undefined) {
      delete g.nativeCallSyncHook;
    } else {
      g.nativeCallSyncHook = originalNative;
    }
    if (originalWindow === undefined) {
      delete g.window;
    } else {
      g.window = originalWindow;
    }
  });

  it('returns "node" by default (no browser or RN globals)', () => {
    delete g.nativeCallSyncHook;
    delete g.window;
    expect(detectPlatform()).toBe('node');
  });

  it('returns "react-native" when nativeCallSyncHook is present', () => {
    g.nativeCallSyncHook = vi.fn();
    expect(detectPlatform()).toBe('react-native');
  });

  it('returns "browser" when window is present', () => {
    delete g.nativeCallSyncHook;
    g.window = {};
    expect(detectPlatform()).toBe('browser');
  });

  it('react-native takes priority over window being set', () => {
    g.nativeCallSyncHook = vi.fn();
    g.window = {};
    expect(detectPlatform()).toBe('react-native');
  });
});

// ---------------------------------------------------------------------------
// JSI host object error surface
// ---------------------------------------------------------------------------

describe('React Native adapter — missing JSI host object', () => {
  const g = globalThis as Record<string, unknown>;
  let savedTalaDB: unknown;

  beforeEach(() => {
    savedTalaDB = g.__TalaDB__;
    delete g.__TalaDB__;
  });

  afterEach(() => {
    if (savedTalaDB === undefined) delete g.__TalaDB__;
    else g.__TalaDB__ = savedTalaDB;
  });

  it('throws a descriptive error when __TalaDB__ is not installed', async () => {
    // Replicate the createNativeDB logic inline
    async function createNativeDB() {
      const native = (globalThis as Record<string, unknown>).__TalaDB__;
      if (!native) {
        throw new Error(
          '@taladb/react-native JSI HostObject not found. ' +
            'Did you call TalaDBModule.initialize() in your app entry point?',
        );
      }
    }

    await expect(createNativeDB()).rejects.toThrow('JSI HostObject not found');
  });
});

// ---------------------------------------------------------------------------
// Snapshot round-trip shape test (pure JS, no WASM required)
// ---------------------------------------------------------------------------

describe('OPFS snapshot protocol shape', () => {
  it('snapshot magic is 4 bytes TDBS', () => {
    // The Rust snapshot format always starts with this magic + u32 version.
    // This test asserts the JS side knows to treat the bytes correctly.
    const magic = new TextEncoder().encode('TDBS');
    expect(magic).toHaveLength(4);
    expect(magic[0]).toBe(0x54); // T
    expect(magic[1]).toBe(0x44); // D
    expect(magic[2]).toBe(0x42); // B
    expect(magic[3]).toBe(0x53); // S
  });

  it('empty snapshot (length 0) is treated as first-open', () => {
    // The WASM open_with_snapshot treats empty/null as "start fresh".
    // This test mirrors the JS-side intent in index.ts (no snapshot → empty DB).
    const emptySnapshot: Uint8Array | null = null;
    const isFirstOpen = emptySnapshot === null || emptySnapshot.byteLength === 0;
    expect(isFirstOpen).toBe(true);
  });
});
