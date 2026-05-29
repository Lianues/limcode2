import { defineResource } from '../../ecs/types';
import type { ClientState } from '../../../shared/protocol';
import type { ClientStateContributorRegistry } from './contributors';

export interface ClientSyncState {
  version: number;
  lastState: ClientState | null;
}

export const ClientStateContributorsKey = defineResource<ClientStateContributorRegistry>('ClientStateContributors');
export const ClientSyncStateKey = defineResource<ClientSyncState>('ClientSyncState');
