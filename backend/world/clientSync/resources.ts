import { defineResource } from '../../ecs/types';
import type { ClientPatchOp, ClientState } from '../../../shared/protocol';
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
  /** 已纳入本同步游标的 dirty conversation resource version。 */
  dirtyConversationResourceVersion: number;
  /** 按 stream 独立维护前端同步游标：global 与 conversation 互不影响。 */
  streams: Record<string, ClientStreamState>;
}

export interface ClientStateDirtyConversationIdsState {
  /** 领域 system 每次标记会递增；ids 可保留为去重集合，消费者按 resourceVersion 判断是否有新标记。 */
  readonly revision: number;
  readonly ids: readonly string[];
}

export interface ClientSyncFastPatchBatch {
  readonly streamId: string;
  readonly patches: readonly ClientPatchOp[];
}

export interface ClientSyncFastPatchState {
  /** 已由领域 system 精确计算好的轻量 patch，ClientSyncSystem 只负责校验、编号和投递。 */
  readonly patches: readonly ClientSyncFastPatchBatch[];
  /** true 时表示流式消息仍在进行，普通 full projection 可以延后到终态或强制 resync。 */
  readonly deferFullSync: boolean;
  /** true 时表示本轮出现了快路径无法表达的变更，必须跑一次 full projection 追平。 */
  readonly requireFullSync: boolean;
}

export const ClientStateContributorsKey = defineResource<ClientStateContributorRegistry>('ClientStateContributors');
export const ClientSyncStateKey = defineResource<ClientSyncState>('ClientSyncState');
export const ClientSyncFastPatchStateKey = defineResource<ClientSyncFastPatchState>('ClientSyncFastPatchState');
export const ClientStateDirtyConversationIdsKey = defineResource<ClientStateDirtyConversationIdsState>('ClientStateDirtyConversationIds');
