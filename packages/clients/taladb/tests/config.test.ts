import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, loadConfig } from '../src/config';

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('accepts an empty config', () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it('accepts config with no sync block', () => {
    expect(() => validateConfig({ sync: undefined })).not.toThrow();
  });

  it('accepts a valid https endpoint', () => {
    expect(() =>
      validateConfig({ sync: { endpoint: 'https://api.example.com/hook' } }),
    ).not.toThrow();
  });

  it('accepts a valid http endpoint (localhost)', () => {
    expect(() =>
      validateConfig({ sync: { endpoint: 'http://localhost:4000/events' } }),
    ).not.toThrow();
  });

  it('rejects a non-http(s) endpoint', () => {
    expect(() =>
      validateConfig({ sync: { endpoint: 'ftp://files.example.com' } }),
    ).toThrow('invalid endpoint URL');
  });

  it('rejects a relative path as endpoint', () => {
    expect(() =>
      validateConfig({ sync: { endpoint: '/relative/path' } }),
    ).toThrow('invalid endpoint URL');
  });

  it('rejects a bare hostname with no scheme', () => {
    expect(() =>
      validateConfig({ sync: { endpoint: 'api.example.com/hook' } }),
    ).toThrow('invalid endpoint URL');
  });

  it('validates insert_endpoint', () => {
    expect(() =>
      validateConfig({ sync: { insert_endpoint: 'not-a-url' } }),
    ).toThrow('invalid endpoint URL');
  });

  it('validates update_endpoint', () => {
    expect(() =>
      validateConfig({ sync: { update_endpoint: 'ws://wrong' } }),
    ).toThrow('invalid endpoint URL');
  });

  it('validates delete_endpoint', () => {
    expect(() =>
      validateConfig({ sync: { delete_endpoint: 'mailto:user@example.com' } }),
    ).toThrow('invalid endpoint URL');
  });

  it('accepts valid per-event endpoints', () => {
    expect(() =>
      validateConfig({
        sync: {
          insert_endpoint: 'https://api.example.com/insert',
          update_endpoint: 'https://api.example.com/update',
          delete_endpoint: 'http://localhost:3000/delete',
        },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'taladb-config-test-'));
}

describe('loadConfig', () => {
  it('returns empty config when no file exists', async () => {
    const dir = tempDir();
    // Temporarily override process.cwd so auto-discovery finds nothing.
    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const cfg = await loadConfig();
      expect(cfg).toEqual({});
    } finally {
      process.cwd = origCwd;
    }
  });

  it('loads a valid JSON config by explicit path', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'taladb.config.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        sync: {
          enabled: true,
          endpoint: 'https://api.example.com/events',
          headers: { Authorization: 'Bearer tok' },
        },
      }),
    );
    const cfg = await loadConfig(filePath);
    expect(cfg.sync?.enabled).toBe(true);
    expect(cfg.sync?.endpoint).toBe('https://api.example.com/events');
    expect(cfg.sync?.headers?.['Authorization']).toBe('Bearer tok');
  });

  it('loads a valid YAML config by explicit path', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'taladb.config.yml');
    writeFileSync(
      filePath,
      [
        'sync:',
        '  enabled: true',
        '  endpoint: "https://hook.example.com"',
        '  headers:',
        '    X-Token: "secret"',
      ].join('\n'),
    );
    const cfg = await loadConfig(filePath);
    expect(cfg.sync?.enabled).toBe(true);
    expect(cfg.sync?.endpoint).toBe('https://hook.example.com');
    expect(cfg.sync?.headers?.['X-Token']).toBe('secret');
  });

  it('auto-discovers taladb.config.yml from cwd', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'taladb.config.yml'),
      'sync:\n  enabled: false\n  endpoint: "https://auto.example.com"\n',
    );
    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const cfg = await loadConfig();
      expect(cfg.sync?.endpoint).toBe('https://auto.example.com');
    } finally {
      process.cwd = origCwd;
    }
  });

  it('prefers .yml over .json when both exist', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'taladb.config.yml'),
      'sync:\n  endpoint: "https://yml.example.com"\n',
    );
    writeFileSync(
      join(dir, 'taladb.config.json'),
      JSON.stringify({ sync: { endpoint: 'https://json.example.com' } }),
    );
    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const cfg = await loadConfig();
      expect(cfg.sync?.endpoint).toBe('https://yml.example.com');
    } finally {
      process.cwd = origCwd;
    }
  });

  it('throws on invalid endpoint URL in config file', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'taladb.config.json');
    writeFileSync(
      filePath,
      JSON.stringify({ sync: { enabled: true, endpoint: 'not-a-url' } }),
    );
    await expect(loadConfig(filePath)).rejects.toThrow('invalid endpoint URL');
  });

  it('throws on unsupported file extension', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'taladb.config.toml');
    writeFileSync(filePath, '[sync]\nenabled = true\n');
    await expect(loadConfig(filePath)).rejects.toThrow('unsupported file extension');
  });

  it('ignores unknown keys in the config', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'taladb.config.json');
    writeFileSync(
      filePath,
      JSON.stringify({ sync: { enabled: false }, unknown_key: 'ignored' }),
    );
    await expect(loadConfig(filePath)).resolves.not.toThrow();
  });

  it('handles sync: disabled by default when key is absent', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'taladb.config.json');
    writeFileSync(filePath, '{}');
    const cfg = await loadConfig(filePath);
    expect(cfg.sync?.enabled).toBeFalsy();
  });
});
