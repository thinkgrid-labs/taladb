export { TalaDBProvider, useTalaDB, useCollectionOptions } from './context'
export type { TalaDBProviderProps, CollectionRegistry, CollectionResolver } from './context'

export { useCollection } from './useCollection'

export { useFind } from './useFind'
export type { FindResult } from './useFind'

export { useFindOne } from './useFindOne'
export type { FindOneResult } from './useFindOne'

export { useAggregate } from './useAggregate'
export type { AggregateResult } from './useAggregate'

// Replication — declare which collections are replicated from which origins.
// Once a collection is *covered*, `useQuery` never touches the network.
export { ReplicationProvider, useReplicationConfig } from './replication/config'
export type {
  ReplicationConfig,
  ReplicationProviderProps,
  PrefetchEntry,
  PrefetchSlice,
  PrefetchMode,
} from './replication/config'
export type { ReplicateRegistry, ReplicateScope, HydrateMode } from './replication/provider'

export { useCoverage, useHydrationProgress } from './useCoverage'
export type { Coverage } from './useCoverage'

export { useQuery } from './useQuery'
export type { UseQueryOptions, QueryResult } from './useQuery'

export { useQueries } from './useQueries'

export { useMutation } from './useMutation'
export type { UseMutationOptions, MutationResult, WriteOp } from './useMutation'
