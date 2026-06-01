import type { WorldReader } from '../../ecs/types';
import { emptyClientState } from '../state/clientState';
import { projectStateWithCache, type ProjectionCache, type ProjectionContributorState, type ProjectionResult } from '../projection/cache';
import type { StorageState, StorageStateContributor, StorageStateSlice } from './contributors';

export type StorageContributorProjectionState = ProjectionContributorState<StorageStateSlice>;
export type StorageProjectionCache = ProjectionCache<StorageStateSlice>;
export type StorageProjectionResult = ProjectionResult<StorageState, StorageStateSlice>;

export function projectStorageStateWithCache(
  world: WorldReader,
  contributors: readonly StorageStateContributor[],
  previous: StorageProjectionCache
): StorageProjectionResult {
  return projectStateWithCache<StorageState, StorageStateSlice>(world, contributors, previous, emptyClientState, 'StorageState');
}

export function projectStorageState(world: WorldReader, contributors: readonly StorageStateContributor[]): StorageState {
  return projectStorageStateWithCache(world, contributors, { projectionClock: '', contributorStates: {} }).state;
}
