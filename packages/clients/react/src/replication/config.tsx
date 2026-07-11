import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { ResolvedReplicationConfig } from './engine'

/**
 * Replication settings shared by `useQuery` / `useMutation`, supplied once by
 * `<ReplicationProvider>` and overridable per hook.
 *
 * The origin is *your* API — never a database credential. It authorizes the
 * session token from {@link ReplicationConfig.getAuth} and returns only that
 * user's slice, so the auth header doubles as the per-user scope.
 */
export interface ReplicationConfig {
  /** Base sync URL, e.g. `/api/sync`. `/push` and `/pull` are appended. */
  endpoint: string
  /**
   * Per-request header resolver — typically `{ Authorization: 'Bearer …' }`.
   * Async so it can await a token refresh. Resolved at **send time**, once per
   * pass, so an offline write flushed later carries a current token.
   */
  getAuth?: () => Promise<Record<string, string>> | Record<string, string>
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Override the `/push` and `/pull` sub-paths to match an existing API. */
  paths?: { push?: string; pull?: string }
  /**
   * Default background refresh interval (ms) for `useQuery`. A replication
   * *interval*, not a cache TTL — the local data is never evicted, only
   * refreshed. Omit or set `0` to disable polling by default; a hook can still
   * opt in per query. `30_000` matches the guide's own example cadence.
   */
  pollMs?: number
}

const ReplicationContext = createContext<ReplicationConfig | null>(null)

export interface ReplicationProviderProps extends ReplicationConfig {
  children: ReactNode
}

/**
 * Supplies replication defaults (endpoint, auth, poll interval) to the
 * `useQuery` / `useMutation` hooks below it. Compose it inside a
 * `<TalaDBProvider>`:
 *
 * ```tsx
 * <TalaDBProvider name="app.db" fallback={<Splash />}>
 *   <ReplicationProvider
 *     endpoint="/api/sync"
 *     getAuth={async () => ({ Authorization: `Bearer ${await session.token()}` })}
 *     pollMs={30_000}
 *   >
 *     <App />
 *   </ReplicationProvider>
 * </TalaDBProvider>
 * ```
 */
export function ReplicationProvider({ children, ...config }: ReplicationProviderProps) {
  // Serialised identity so an inline `getAuth`/`paths` object on every render
  // doesn't produce a new context value and re-run every consumer's effects.
  // Functions can't serialise; key on the scalar fields and keep the latest
  // object. getAuth is called fresh each pass regardless, so staleness is moot.
  const key = `${config.endpoint}|${config.pollMs ?? ''}|${JSON.stringify(config.paths ?? null)}`
  const value = useMemo(
    () => config,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  )
  return <ReplicationContext.Provider value={value}>{children}</ReplicationContext.Provider>
}

/**
 * Merge a base replication config with per-hook overrides, field-by-field so an
 * override left `undefined` falls back to the base value instead of clobbering
 * it. Pure (no hooks) so it can run per-item inside `useQueries`. Returns a
 * `null` config when no endpoint is resolvable (valid for `local-only`).
 */
export function resolveReplicationConfig(
  base: ReplicationConfig | null,
  overrides?: Partial<ReplicationConfig>,
): { config: ResolvedReplicationConfig | null; pollMs: number } {
  const endpoint = overrides?.endpoint ?? base?.endpoint
  const pollMs = overrides?.pollMs ?? base?.pollMs ?? 0
  if (!endpoint) return { config: null, pollMs }
  return {
    config: {
      endpoint,
      getAuth: overrides?.getAuth ?? base?.getAuth,
      fetch: overrides?.fetch ?? base?.fetch,
      paths: overrides?.paths ?? base?.paths,
    },
    pollMs,
  }
}

/** The nearest replication base config, or `null` if there's no provider. */
export function useReplicationBase(): ReplicationConfig | null {
  return useContext(ReplicationContext)
}

/**
 * Read the nearest replication config, merged with per-hook overrides.
 * Non-throwing: `config` is `null` when no endpoint is resolvable (valid for
 * `source: 'local-only'`); the caller decides whether that's an error.
 */
export function useReplicationConfig(
  overrides?: Partial<ReplicationConfig>,
): { config: ResolvedReplicationConfig | null; pollMs: number } {
  return resolveReplicationConfig(useContext(ReplicationContext), overrides)
}
