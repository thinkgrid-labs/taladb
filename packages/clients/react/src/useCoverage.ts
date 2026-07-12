import { isAuthoritative, progress as progressOf, rowsApplied, type CoverageState } from 'taladb'
import { useReplication } from './replication/provider'

export interface Coverage {
  /** The raw state machine value. */
  status: CoverageState['status']
  /**
   * Whether a purely local read is authorized.
   *
   * True **only** for `complete`. Notably *not* for `best-effort`, which means we
   * applied every row the origin gave us but the origin could not pin a snapshot —
   * so a row that shifted between pages during the walk may never have been seen,
   * and we cannot prove the replica is whole. Serving that as authoritative would
   * silently return incomplete results, which is worse than going to the network.
   */
  ready: boolean
  /** Rows hydrated so far. */
  rows: number
  /** Total rows in scope when supplied by the origin. */
  total?: number
  /** 0–1 when the origin reported a total; otherwise undefined. */
  progress?: number
  /** Present on `error`, `stale` and `best-effort`. */
  reason?: string
}

/**
 * How much of a collection is local, and whether it can be trusted for a
 * network-free read.
 *
 * @example
 * const { ready, progress } = useCoverage('products')
 * if (!ready) return <ProgressBar value={progress} />
 */
export function useCoverage(collection: string): Coverage {
  const replication = useReplication()
  const state: CoverageState = replication?.coverage[collection] ?? { status: 'empty' }

  return {
    status: state.status,
    ready: isAuthoritative(state),
    rows: rowsApplied(state),
    total: 'total' in state ? state.total : undefined,
    progress: progressOf(state),
    reason:
      state.status === 'error'
        ? state.error
        : state.status === 'best-effort' || state.status === 'stale'
          ? state.reason
          : undefined,
  }
}

/** Semantic alias for progress-oriented UIs. */
export const useHydrationProgress = useCoverage
