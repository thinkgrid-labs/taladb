/**
 * Browser stub for the Node.js-only config loader.
 *
 * On the browser platform, config is always passed inline via `openDB` options —
 * file-based discovery (`taladb.config.yml`) is a Node.js-only feature.
 * This stub replaces `config.ts` in the browser build so that `js-yaml` and
 * `node:fs` / `node:path` never appear in the browser-facing bundle.
 */

// ---------------------------------------------------------------------------
// Types (duplicated from config.ts — erased at runtime, kept for DX)
// ---------------------------------------------------------------------------

export interface SyncConfig {
  enabled?: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  insert_endpoint?: string;
  update_endpoint?: string;
  delete_endpoint?: string;
  exclude_fields?: string[];
}

export interface TalaDbConfig {
  sync?: SyncConfig;
}

// ---------------------------------------------------------------------------
// validateConfig — inline copy (no dynamic imports)
// ---------------------------------------------------------------------------

const ENDPOINT_FIELDS = [
  'endpoint',
  'insert_endpoint',
  'update_endpoint',
  'delete_endpoint',
] as const;

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
// loadConfig — no-op stub (file discovery is Node.js-only)
// ---------------------------------------------------------------------------

export async function loadConfig(_configPath?: string): Promise<TalaDbConfig> {
  return {};
}
