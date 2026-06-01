import type { ClientState } from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateRegistry';
import type { WorldReader } from '../../ecs/types';
import type { ClientStateContributor, ClientStateSlice } from './contributors';
import { projectStateWithCache, type ProjectionCache, type ProjectionContributorState, type ProjectionResult } from '../projection/cache';

export type ClientContributorProjectionState = ProjectionContributorState<ClientStateSlice>;
export type ClientStateProjectionCache = ProjectionCache<ClientStateSlice>;
export type ClientStateProjectionResult = ProjectionResult<ClientState, ClientStateSlice>;

export { createEmptyClientState } from '../../../shared/clientStateRegistry';

export function projectClientStateWithCache(
  world: WorldReader,
  contributors: readonly ClientStateContributor[],
  previous: ClientStateProjectionCache
): ClientStateProjectionResult {
  return projectStateWithCache<ClientState, ClientStateSlice>(world, contributors, previous, createEmptyClientState, 'ClientState');
}

export function projectClientState(world: WorldReader, contributors: readonly ClientStateContributor[]): ClientState {
  return projectClientStateWithCache(world, contributors, { projectionClock: '', contributorStates: {} }).state;
}
