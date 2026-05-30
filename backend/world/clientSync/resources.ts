import { defineResource } from '../../ecs/types';
import type { ClientState } from '../../../shared/protocol';
import type { ClientStateContributorRegistry } from './contributors';

export interface ClientStreamState {
  /** 当前 stream 已投递到前端的顺序号，用于检测 patch 是否断链。 */
  streamSeq: number;
  lastState: ClientState | null;
}

export interface ClientSyncState {
  /** 仍保留完整 ClientState，供持久化和全量投影比较使用。 */
  lastState: ClientState | null;
  /** 按 stream 独立维护前端同步游标：global 与 conversation 互不影响。 */
  streams: Record<string, ClientStreamState>;
}

export const ClientStateContributorsKey = defineResource<ClientStateContributorRegistry>('ClientStateContributors');
export const ClientSyncStateKey = defineResource<ClientSyncState>('ClientSyncState');
