import { defineStore } from 'pinia';
import { createEmptyClientState } from '@shared/clientStateSchema';
import {
  conversationClientStateStreamId,
  isFunctionResponsePart,
  type AgentRunRecord,
  type AgentRunStatus,
  type CheckpointRecord,
  type CheckpointTimelineAnchorRecord,
  type ClientPatchOp,
  type ClientState,
  type ConversationRecord,
  type CompressionBlockRecord,
  type MessageRecord,
  type ProjectContextRecord,
  type WorkEnvironmentRecord
} from '@shared/protocol';
import { workEnvironmentSortKey as buildWorkEnvironmentSortKey } from '@shared/workEnvironmentCatalog';
import { createClientStateDb, type ClientStateDb } from './clientStateDb';

export interface ClientStateStoreState extends ClientState {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  /** 当前 webview 聚焦的对话 id（单对话场景，由 session 驱动 + 默认回落）。 */
  currentConversationId: string;
}

/** 当前对话的模型 / 模式概要，供标签头展示。 */
export interface CurrentModelSummary {
  agentName?: string;
  modeName?: string;
  model?: string;
}

export interface CurrentRunSummary {
  activeRuns: AgentRunRecord[];
  primaryRun?: AgentRunRecord;
  status?: AgentRunStatus;
  label: string;
  isRunning: boolean;
}

const TERMINAL_AGENT_RUN_STATUSES = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled', 'stale']);

export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return !TERMINAL_AGENT_RUN_STATUSES.has(status);
}

const dbByStore = new WeakMap<object, ClientStateDb>();

function dbFor(store: ClientStateStoreState): ClientStateDb {
  const key = store as object;
  let db = dbByStore.get(key);
  if (!db) {
    db = createClientStateDb(store);
    dbByStore.set(key, db);
  }
  return db;
}

/**
 * 同步自后端的 ClientState 投影。
 *
 * 只负责"应用 snapshot/patch + 暴露按当前对话过滤的只读视图"，
 * 领域语义由 shared/clientStateSchema 驱动的 clientStateDb 执行器机械完成。
 */
export const useClientStateStore = defineStore('clientState', {
  state: (): ClientStateStoreState => ({
    ...createEmptyClientState(),
    streamSeqs: {},
    currentConversationId: ''
  }),
  getters: {
    currentConversationDetailLoaded(state): boolean {
      if (!state.currentConversationId) return false;
      return (state.streamSeqs[conversationClientStateStreamId(state.currentConversationId)] ?? 0) > 0;
    },
    currentConversation(state): ConversationRecord | undefined {
      return state.conversations.find((conversation) => conversation.id === state.currentConversationId);
    },
    currentProjectContext(state): ProjectContextRecord | undefined {
      const link = state.conversationProjectLinks.find(
        (candidate) => candidate.conversationId === state.currentConversationId && candidate.role === 'primary'
      );
      return state.projectContexts.find((candidate) => candidate.id === link?.projectContextId);
    },
    currentWorkEnvironment(state): WorkEnvironmentRecord | undefined {
      const link = state.conversationWorkEnvironmentLinks.find(
        (candidate) => candidate.conversationId === state.currentConversationId && candidate.role === 'active'
      );
      const linked = state.workEnvironments.find((candidate) => candidate.id === link?.workEnvironmentId && candidate.available);
      if (linked) return linked;
      return state.workEnvironments
        .filter((candidate) => candidate.available)
        .sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id))
        [0];
    },
    /** 当前对话下、按 seq 排序、剔除纯工具响应的消息（工具响应不直接展示）。 */
    currentMessages(state): MessageRecord[] {
      return state.messages
        .filter(
          (message) =>
            message.conversationId === state.currentConversationId &&
            !message.content.parts.some(isFunctionResponsePart)
        )
        .sort((left, right) => left.seq - right.seq);
    },
    currentCheckpoints(state): CheckpointRecord[] {
      return state.checkpoints
        .filter((checkpoint) => checkpoint.conversationId === state.currentConversationId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentCheckpointTimelineAnchors(state): CheckpointTimelineAnchorRecord[] {
      return state.checkpointTimelineAnchors
        .filter((anchor) => anchor.conversationId === state.currentConversationId)
        .sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentCompressionBlocks(state): CompressionBlockRecord[] {
      return state.compressionBlocks
        .filter((block) => block.conversationId === state.currentConversationId)
        .sort((left, right) => (left.anchorSeq ?? left.endSeq ?? 0) - (right.anchorSeq ?? right.endSeq ?? 0) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentActiveRuns(state): AgentRunRecord[] {
      return activeRunsForConversation(state, state.currentConversationId);
    },
    currentRunSummary(state): CurrentRunSummary {
      const activeRuns = activeRunsForConversation(state, state.currentConversationId);
      const primaryRun = activeRuns[0];
      return {
        activeRuns,
        ...(primaryRun ? { primaryRun, status: primaryRun.status } : {}),
        label: primaryRun ? labelForRunStatus(primaryRun.status) : '空闲',
        isRunning: activeRuns.length > 0
      };
    },
    currentModelSummary(state): CurrentModelSummary {
      const agentSelection = state.conversationAgentSelections
        .filter((selection) => selection.conversationId === state.currentConversationId && selection.role === 'active')
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
      const agentLink = agentSelection
        ? undefined
        : state.agentConversationLinks.find((link) => link.conversationId === state.currentConversationId && link.role === 'default') ??
          state.agentConversationLinks.find((link) => link.conversationId === state.currentConversationId);
      const agent = state.agents.find((candidate) => candidate.id === (agentSelection?.agentId ?? agentLink?.agentId));

      const conversationModeSelection = state.conversationModeSelections.find(
        (selection) => selection.conversationId === state.currentConversationId && selection.role === 'active'
      );
      const mode = conversationModeSelection
        ? conversationModeSelection.scopeKind === 'mode'
          ? state.modes.find((candidate) => candidate.id === conversationModeSelection.modeId)
          : undefined
        : undefined;

      const profileLink = latestScopeLink(state.modelProfileScopeLinks.filter((link) =>
        link.role === 'active' && (
          (link.scopeKind === 'conversation' && link.scopeId === state.currentConversationId) ||
          (mode && link.scopeKind === 'mode' && link.scopeId === mode.id) ||
          (agent && link.scopeKind === 'agent' && link.scopeId === agent.id) ||
          link.scopeKind === 'global'
        )
      ));
      const profile = state.modelProfiles.find((candidate) => candidate.id === profileLink?.modelProfileId);

      return { agentName: agent?.name, modeName: mode?.name, model: profile?.model };
    }
  },
  actions: {
    applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
      this.streamSeqs[streamId] = streamSeq;
      if (!dbFor(this).applySnapshot(streamId, state)) return;
      this.ensureCurrentConversation();
    },
    applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean {
      const currentStreamSeq = this.streamSeqs[streamId] ?? 0;
      if (streamSeq !== currentStreamSeq + 1) return false;
      dbFor(this).applyPatches(patches);
      this.streamSeqs[streamId] = streamSeq;
      this.ensureCurrentConversation();
      return true;
    },
    setCurrentConversation(conversationId: string): void {
      if (conversationId) this.currentConversationId = conversationId;
    },
    /** Hello 未提供 conversationId（"加载默认"入口）时，待快照到达后回落 default / 首个对话。 */
    ensureCurrentConversation(): void {
      const hasCurrent =
        !!this.currentConversationId &&
        this.conversations.some((conversation) => conversation.id === this.currentConversationId);
      if (!hasCurrent) {
        this.currentConversationId =
          this.conversations.find((conversation) => conversation.id === 'default')?.id ??
          this.conversations[0]?.id ??
          '';
      }
    }
  }
});

function activeRunsForConversation(state: ClientStateStoreState, conversationId: string): AgentRunRecord[] {
  if (!conversationId) return [];
  const runIds = new Set(
    state.agentRunTargetLinks
      .filter((link) => link.conversationId === conversationId)
      .map((link) => link.runId)
  );
  if (runIds.size === 0) return [];
  return state.agentRuns
    .filter((run) => runIds.has(run.id) && isActiveAgentRunStatus(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id));
}

function labelForRunStatus(status: AgentRunStatus): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'preparing':
      return '准备中';
    case 'running':
      return '执行中';
    case 'waiting_tool':
      return '等待工具';
    case 'waiting_child_run':
      return '等待子任务';
    case 'delivering':
      return '整理回复';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已终止';

    case 'stale':
      return '已过期';
  }
}

function workEnvironmentSortKey(environment: WorkEnvironmentRecord): string {
  return buildWorkEnvironmentSortKey(environment);
}

function latestScopeLink<T extends { createdAt: number; updatedAt: number; id: string }>(links: T[]): T | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

