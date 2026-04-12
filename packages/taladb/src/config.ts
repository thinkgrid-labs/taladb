// ============================================================
// TalaDB config loader — Phase 1
//
// Parses and validates `taladb.config.yml` / `taladb.config.json`.
// In Phase 1 the parsed config is available but drives no behaviour —
// the HTTP sync adapter is wired up in Phase 3.
// ============================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** HTTP push sync settings. */
export interface SyncConfig {
  /**
   * Enable HTTP push sync. Defaults to `false`.
   * Everything is a no-op when disabled, so a config block without
   * `enabled: true` is safe to ship.
   */
  enabled?: boolean;
  /**
   * Default endpoint URL that receives all mutation events.
   * Required when `enabled: true`.
   */
  endpoint?: string;
  /** HTTP headers sent with every outgoing request (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /** Override the endpoint for `insert` events only. */
  insert_endpoint?: string;
  /** Override the endpoint for `update` events only. */
  update_endpoint?: string;
  /** Override the endpoint for `delete` events only. */
  delete_endpoint?: string;
  /**
   * Document fields to omit from every outgoing sync payload.
   *
   * Useful for stripping large computed fields such as embedding vectors
   * that the remote endpoint doesn't need.
   *
   * @example
   * exclude_fields: ['embedding', 'clip_vector']
   */
  exclude_fields?: string[];
}

/** Top-level TalaDB configuration. */
export interface TalaDbConfig {
  /** HTTP push sync configuration. Disabled by default. */
  sync?: SyncConfig;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ENDPOINT_FIELDS = [
  'endpoint',
  'insert_endpoint',
  'update_endpoint',
  'delete_endpoint',
] as const;

/**
 * Validate a parsed `TalaDbConfig`.
 *
 * Checks that every endpoint URL (if present) starts with `http://` or
 * `https://`. Throws a plain `Error` on the first invalid value.
 */
export function validateConfig(config: TalaDbConfig): void {
  const sync = config.sync;
  if (!sync) return;
  for (const key of ENDPOINT_FIELDS) {
    const url = sync[key];
    if (url !== undefined && !url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(
        `TalaDB config: invalid endpoint URL "${url}" — must start with http:// or https://`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate a TalaDB config file.
 *
 * - Supports `.json`, `.yml`, and `.yaml` extensions.
 * - YAML parsing requires `js-yaml` (already in `taladb`'s dependencies).
 * - Only runs in Node.js. Returns `{}` silently on browser / React Native.
 * - Returns `{}` (sync disabled) when no config file is found — **not an error**.
 *
 * @param configPath  Explicit path to the config file. If omitted, auto-discovers
 *                    `taladb.config.yml`, `taladb.config.yaml`, or
 *                    `taladb.config.json` from `process.cwd()`.
 */
export async function loadConfig(configPath?: string): Promise<TalaDbConfig> {
  // Non-Node platforms: sync is silently disabled.
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
    return {};
  }

  const { join, extname } = await import('node:path');
  const { readFile, access } = await import('node:fs/promises');

  async function parseFile(filePath: string): Promise<TalaDbConfig> {
    const content = await readFile(filePath, 'utf8');
    const ext = extname(filePath).toLowerCase();

    let raw: unknown;
    if (ext === '.json') {
      raw = JSON.parse(content);
    } else if (ext === '.yml' || ext === '.yaml') {
      // Dynamic import so the js-yaml parse cost is only paid when needed.
      const yaml = await import('js-yaml');
      raw = yaml.load(content);
    } else {
      throw new Error(
        `TalaDB config: unsupported file extension "${ext}" — use .json, .yml, or .yaml`,
      );
    }

    const config = ((raw !== null && typeof raw === 'object' ? raw : {}) as TalaDbConfig);
    validateConfig(config);
    return config;
  }

  if (configPath) {
    return parseFile(configPath);
  }

  // Auto-discover from cwd.
  const cwd = process.cwd();
  for (const name of ['taladb.config.yml', 'taladb.config.yaml', 'taladb.config.json']) {
    const full = join(cwd, name);
    try {
      await access(full);
      return parseFile(full);
    } catch {
      // File doesn't exist — try the next candidate.
    }
  }

  // No config file found — sync is disabled, which is the default.
  return {};
}
