import { defineResource } from '../../ecs/types';
import type { ClientState } from '../../../shared/protocol';
import type { ClientStateContributorRegistry } from './contributors';
import type { ClientContributorProjectionState } from './projection';

export interface ClientStreamState {
  /** 当前 stream 已投递到前端的顺序号，用于检测 patch 是否断链。 */
  streamSeq: number;
  lastState: ClientState | null;
}

export interface ClientSyncState {
  /**
   * 最近一次 ClientSync 投影缓存。
   * 只服务于前端 state stream 的 snapshot/patch/resync，不作为 storage 的强一致数据源。
   */
  lastState: ClientState | null;
  /** lastState/contributorStates 对应的 ECS component/resource 版本时钟。 */
  projectionClock: string;
  /** 每个 ClientState contributor 的独立投影缓存，用于按 reads clock 复用未变化 slice。 */
  contributorStates: Record<string, ClientContributorProjectionState>;
  /** 按 stream 独立维护前端同步游标：global 与 conversation 互不影响。 */
  streams: Record<string, ClientStreamState>;
}

export const ClientStateContributorsKey = defineResource<ClientStateContributorRegistry>('ClientStateContributors');
export const ClientSyncStateKey = defineResource<ClientSyncState>('ClientSyncState');
