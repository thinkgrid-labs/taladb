import { useCallback, useEffect, useRef, useState } from 'react'
import type { Document, Filter, Update } from 'taladb'
import { useCollection } from './useCollection'
import { useTalaDB } from './context'
import { useReplicationConfig, type ReplicationConfig } from './replication/config'
import { replicateWithRetry, type ResolvedReplicationConfig } from './replication/engine'

/** A single write intent against the local replica. Discriminated on `type`. */
export type WriteOp<T extends Document> =
  | { type: 'insert'; doc: Omit<T, '_id'> }
  | { type: 'update'; where: Filter<T>; set: Partial<Omit<T, '_id'>> }
  | { type: 'delete'; where: Filter<T> }

export interface UseMutationOptions
  extends Partial<Pick<ReplicationConfig, 'endpoint' | 'getAuth' | 'fetch' | 'paths'>> {
  /** Collection the write targets. */
  collection: string
  /**
   * Replication direction for the drain. `push` *(default)* sends the write;
   * read hooks reconcile the authoritative value on their next pull. `both`
   * also pulls the authoritative echo inline (heavier — replays the collection).
   */
  direction?: 'push' | 'both'
  /**
   * On mount, attempt to flush any local writes left unsent from a previous
   * (offline) session for this collection. Default `true`.
   */
  drainOnMount?: boolean
}

export interface MutationResult<T extends Document> {
  /** Fire-and-forget write. Errors surface on `error`, never thrown to render. */
  mutate: (op: WriteOp<T>) => void
  /** Awaitable write. Resolves once the local write and drain settle; rejects on error. */
  mutateAsync: (op: WriteOp<T>) => Promise<void>
  /** A write (local + drain) is in flight. */
  pending: boolean
  /** Most recent write/drain error. The local write is durable regardless. */
  error: unknown | null
}

/**
 * Local-first write hook. A mutation writes the local replica **first**
 * (immediate, durable, reactive — every `useQuery`/`useFind` on the collection
 * re-renders) and then replicates the change outward over the sync-contract with
 * bounded retry. The network step never rolls the local write back: it is
 * already committed, and a later drain still delivers it (write-behind).
 *
 * Write-authority is origin-authoritative by default — the push sends the
 * change and the server is the arbiter; read hooks pull the authoritative value.
 *
 * @example
 * const { mutate, pending } = useMutation<Order>({ collection: 'orders' })
 * mutate({ type: 'update', where: { _id }, set: { status: 'shipped' } })
 */
export function useMutation<T extends Document>(options: UseMutationOptions): MutationResult<T> {
  const { collection, direction = 'push', drainOnMount = true } = options
  const db = useTalaDB()
  const col = useCollection<T>(collection)

  const { config } = useReplicationConfig({
    endpoint: options.endpoint,
    getAuth: options.getAuth,
    fetch: options.fetch,
    paths: options.paths,
  })
  const configRef = useRef<ResolvedReplicationConfig | null>(config)
  configRef.current = config

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown | null>(null)

  const endpoint = config?.endpoint

  const applyLocal = useCallback(
    async (op: WriteOp<T>): Promise<void> => {
      switch (op.type) {
        case 'insert':
          await col.insert(op.doc)
          return
        case 'update':
          await col.updateOne(op.where, { $set: op.set } as Update<T>)
          return
        case 'delete':
          await col.deleteOne(op.where)
          return
      }
    },
    [col],
  )

  const drain = useCallback(async (): Promise<void> => {
    const cfg = configRef.current
    if (!cfg) return
    await replicateWithRetry(db, cfg, collection, direction)
    // `endpoint` (stable string) stands in for the config object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, collection, direction, endpoint])

  const mutateAsync = useCallback(
    async (op: WriteOp<T>): Promise<void> => {
      setPending(true)
      setError(null)
      try {
        await applyLocal(op) // durable, reactive, offline-capable
        await drain() // replicate out (retries; never rolls local back)
      } catch (e) {
        setError(e)
        throw e
      } finally {
        setPending(false)
      }
    },
    [applyLocal, drain],
  )

  const mutate = useCallback(
    (op: WriteOp<T>): void => {
      void mutateAsync(op).catch(() => {
        /* surfaced on `error`; swallow so it doesn't become an unhandled rejection */
      })
    },
    [mutateAsync],
  )

  // Best-effort flush of writes stranded from a previous offline session.
  useEffect(() => {
    if (!drainOnMount || !configRef.current) return
    void drain().catch(() => {
      /* surfaced on the next mutation's `error`; a mount drain stays quiet */
    })
  }, [drain, drainOnMount])

  // A write must have somewhere to replicate to. Placed after all hooks so hook
  // order is identical on every render.
  if (!config) {
    throw new Error(
      `useMutation({ collection: '${collection}' }) needs an endpoint. ` +
        'Wrap the tree in <ReplicationProvider endpoint="…"> or pass { endpoint }.',
    )
  }

  return { mutate, mutateAsync, pending, error }
}
