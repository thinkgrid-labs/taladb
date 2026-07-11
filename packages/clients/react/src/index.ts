export { TalaDBProvider, useTalaDB } from './context'
export type { TalaDBProviderProps } from './context'

export { useCollection } from './useCollection'

export { useFind } from './useFind'
export type { FindResult } from './useFind'

export { useFindOne } from './useFindOne'
export type { FindOneResult } from './useFindOne'

// Scoped replication — bind a component to a slice of a remote origin, backed
// by the local replica. See docs/scoped-replication.md.
export { ReplicationProvider, useReplicationConfig } from './replication/config'
export type {
  ReplicationConfig,
  ReplicationProviderProps,
  PrefetchEntry,
  PrefetchSlice,
  PrefetchMode,
} from './replication/config'

export { useQuery } from './useQuery'
export type { UseQueryOptions, QueryResult, ReadSource } from './useQuery'

export { useQueries } from './useQueries'

export { useMutation } from './useMutation'
export type { UseMutationOptions, MutationResult, WriteOp } from './useMutation'
