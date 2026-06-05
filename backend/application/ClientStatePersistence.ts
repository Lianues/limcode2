import type { WorldReader } from '../ecs/types';
import type { StorageCapability } from '../capabilities/types';
import { StorageStateContributorsKey } from '../world/storageProjection/resources';
import { projectStorageStateWithCache, type StorageContributorProjectionState } from '../world/storageProjection/projection';
import type { AgentRunStatus, ClientState, MessageContent, MessageRecord, SidebarConversationHistoryEntry } from '../../shared/protocol';
import { DEFAULT_CONVERSATION_ID } from './defaults';
import { conversationDetailSlice } from '../capabilities/vscodeStorage/clientStateStore';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

export interface ClientStatePersistenceOptions {
  isConversationDetailLoaded?: (conversationId: string) => boolean;
  loadedConversationIds?: () => Iterable<string>;
}

/**
 * Storage 持久化使用独立投影缓存。懒加载后必须把骨架与对话详情分开保存，
 * 避免只加载部分 detail 时把未加载对话的消息文件写成空数组。
 */
export class ClientStatePersistence {
  private enabled = false;
  private lastPersistedSkeletonJson = '';
  private pendingSkeletonState: ClientState | undefined;
  private readonly lastPersistedDetailJson = new Map<string, string>();
  private readonly pendingDetailStates = new Map<string, ClientState>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  private projectionClock = '';
  private contributorStates: Record<string, StorageContributorProjectionState> = {};
  private lastProjectedState: ClientState | undefined;

  public constructor(
    private readonly world: WorldReader,
    private readonly storage: StorageCapability,
    private readonly options: ClientStatePersistenceOptions = {},
    private readonly debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS
  ) {}

  public enable(): void { this.enabled = true; }

  public rememberPersistedState(state: ClientState): void {
    this.lastPersistedSkeletonJson = JSON.stringify(skeletonPersistenceSlice(state));
    this.lastProjectedState = state;
    this.projectionClock = '';
    this.contributorStates = {};
    this.lastPersistedDetailJson.clear();
  }

  public queuePersist(): void {
    if (!this.enabled) return;
    const projection = this.projectLatestState();
    if (!projection || !projection.changed) return;
    this.collectPendingStates(projection.state, false);
    this.scheduleIfPending();
  }

  public async persistImmediately(options: { force?: boolean; throwOnError?: boolean } = {}): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    const latestState = this.projectLatestState()?.state ?? this.lastProjectedState;
    if (!this.enabled || !latestState) return;

    this.collectPendingStates(latestState, !!options.force);
    if (!this.pendingSkeletonState && this.pendingDetailStates.size === 0) return;

    const skeletonState = this.pendingSkeletonState;
    const detailStates = [...this.pendingDetailStates.entries()];
    this.pendingSkeletonState = undefined;
    this.pendingDetailStates.clear();

    try {
      if (skeletonState) {
        await this.storage.saveClientStateSkeleton(skeletonState);
        this.lastPersistedSkeletonJson = JSON.stringify(skeletonPersistenceSlice(skeletonState));
      }

      for (const [conversationId, state] of detailStates) {
        await this.storage.saveConversationDetail(conversationId, state);
        this.lastPersistedDetailJson.set(conversationId, JSON.stringify(conversationDetailSlice(state, conversationId)));
        const entry = projectConversationHistoryEntry(state, conversationId);
        if (entry) await this.storage.upsertConversationHistoryEntry(entry);
      }
    } catch (error) {
      console.warn('[LimCode] Failed to persist client state:', error);
      if (options.throwOnError) throw error;
    }
  }

  private collectPendingStates(state: ClientState, force: boolean): void {
    const skeletonJson = JSON.stringify(skeletonPersistenceSlice(state));
    if (force || skeletonJson !== this.lastPersistedSkeletonJson) {
      this.pendingSkeletonState = state;
    }

    for (const conversationId of this.loadedConversationIds(state)) {
      const detail = conversationDetailSlice(state, conversationId);
      const detailJson = JSON.stringify(detail);
      if (!force && detailJson === this.lastPersistedDetailJson.get(conversationId)) continue;
      this.pendingDetailStates.set(conversationId, state);
    }
  }

  private loadedConversationIds(state: ClientState): string[] {
    const explicit = this.options.loadedConversationIds ? [...this.options.loadedConversationIds()] : undefined;
    if (explicit) return explicit.filter((id) => this.options.isConversationDetailLoaded?.(id) ?? true);
    const ids = new Set(state.messages.map((message) => message.conversationId));
    for (const conversation of state.conversations) {
      if (this.options.isConversationDetailLoaded?.(conversation.id)) ids.add(conversation.id);
    }
    return [...ids];
  }

  private scheduleIfPending(): void {
    if (!this.pendingSkeletonState && this.pendingDetailStates.size === 0) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { void this.persistImmediately(); }, this.debounceMs);
  }

  private projectLatestState(): { state: ClientState; changed: boolean } | undefined {
    const registry = this.world.tryGetResource(StorageStateContributorsKey);
    if (!registry) return this.lastProjectedState ? { state: this.lastProjectedState, changed: false } : undefined;

    const projection = projectStorageStateWithCache(this.world, registry.list(), {
      projectionClock: this.projectionClock,
      contributorStates: this.contributorStates
    });
    this.projectionClock = projection.projectionClock;
    this.contributorStates = projection.contributorStates;
    this.lastProjectedState = projection.state;
    return { state: projection.state, changed: projection.changed };
  }
}

function skeletonPersistenceSlice(state: ClientState): ClientState {
  return {
    ...state,
    messages: [],
    messageRevisions: [],
    messageCurrentRevisionLinks: [],
    toolCalls: [],
    toolCallEvents: [],
    agentRuns: [],
    agentRunSourceLinks: [],
    agentRunTargetLinks: [],
    messageRunLinks: [],
    toolCallRunLinks: [],
    runConversationPolicies: [],
    runContextPolicies: [],
    runDeliveryPolicies: [],
    runEditPolicies: [],
    runModeLinks: [],
    runSystemPromptLinks: [],
    runModelProfileLinks: [],
    runToolPolicyLinks: [],
    runApprovalPolicyLinks: [],
    runConversationPolicyLinks: [],
    runContextPolicyLinks: [],
    runDeliveryPolicyLinks: [],
    runEditPolicyLinks: [],
    agentRunInputRevisions: []
  };
}

function projectConversationHistoryEntry(state: ClientState, conversationId: string): SidebarConversationHistoryEntry | undefined {
  const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
  if (!conversation) return undefined;
  const messages = state.messages
    .filter((message) => message.conversationId === conversationId)
    .sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt);
  const latest = latestMessage(messages);
  const runSummary = activeRunSummary(state, conversationId);
  const project = projectInfoForConversation(state, conversationId);
  const title = conversationTitle(conversation.id, conversation.title, messages);
  const entry: SidebarConversationHistoryEntry = {
    id: conversation.id,
    title,
    preview: latest ? messagePreview(latest) : '暂无消息，点击开始新的交流。',
    messageCount: messages.length,
    status: latest?.status ?? 'empty',
    isRunning: !!runSummary,
    ...(latest ? { updatedAt: latest.createdAt } : {}),
    ...(agentNameForConversation(state, conversationId) ? { agentName: agentNameForConversation(state, conversationId) } : {}),
    ...(project?.uri ? { projectFolderUri: project.uri } : {}),
    ...(project?.name ? { projectName: project.name } : {})
  };
  if (runSummary) {
    entry.runStatus = runSummary.status;
    entry.runStatusLabel = runSummary.label;
    entry.updatedAt = Math.max(entry.updatedAt ?? 0, runSummary.updatedAt);
  }
  return entry;
}

function latestMessage(messages: MessageRecord[]): MessageRecord | undefined {
  return messages.reduce<MessageRecord | undefined>((latest, message) => {
    if (!latest) return message;
    return message.createdAt > latest.createdAt || (message.createdAt === latest.createdAt && message.seq > latest.seq) ? message : latest;
  }, undefined);
}

function conversationTitle(conversationId: string, title: string | undefined, messages: MessageRecord[]): string {
  const explicitTitle = normalizeText(title ?? '');
  if (explicitTitle && explicitTitle !== '新对话') return truncateText(explicitTitle, 28);
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const titleFromMessage = firstUserMessage ? normalizeText(textPreview(firstUserMessage.content)) : '';
  if (titleFromMessage) return truncateText(titleFromMessage, 28);
  if (conversationId === DEFAULT_CONVERSATION_ID) return '默认对话';
  return explicitTitle || '新对话';
}

function messagePreview(message: MessageRecord): string {
  const text = normalizeText(textPreview(message.content));
  if (text) return truncateText(text, 72);
  return message.role === 'user' ? '用户消息' : '助手消息';
}

function textPreview(content: MessageContent): string {
  for (const part of content.parts) {
    if ('text' in part && part.thought !== true && part.text.trim()) return part.text;
    if ('functionCall' in part) return `调用工具：${part.functionCall.name}`;
    if ('functionResponse' in part) return `工具返回：${part.functionResponse.name}`;
    if ('fileData' in part) return `文件：${part.fileData.uri}`;
    if ('inlineData' in part) return `附件：${part.inlineData.mimeType}`;
  }
  return '';
}

function activeRunSummary(state: ClientState, conversationId: string): { status: AgentRunStatus; label: string; updatedAt: number } | undefined {
  const runIds = new Set(state.agentRunTargetLinks.filter((link) => link.conversationId === conversationId).map((link) => link.runId));
  return state.agentRuns
    .filter((run) => runIds.has(run.id) && isActiveAgentRunStatus(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    ? (() => {
        const run = state.agentRuns.filter((candidate) => runIds.has(candidate.id) && isActiveAgentRunStatus(candidate.status)).sort((left, right) => right.updatedAt - left.updatedAt)[0];
        return { status: run.status, label: labelForAgentRunStatus(run.status), updatedAt: run.updatedAt };
      })()
    : undefined;
}

function agentNameForConversation(state: ClientState, conversationId: string): string | undefined {
  const link = state.agentConversationLinks.find((candidate) => candidate.conversationId === conversationId && candidate.role === 'default')
    ?? state.agentConversationLinks.find((candidate) => candidate.conversationId === conversationId);
  return state.agents.find((agent) => agent.id === link?.agentId)?.name;
}

function projectInfoForConversation(state: ClientState, conversationId: string): { uri: string; name: string } | undefined {
  const link = state.conversationProjectLinks.find((candidate) => candidate.conversationId === conversationId && candidate.role === 'primary');
  const project = state.projectContexts.find((candidate) => candidate.id === link?.projectContextId);
  return project ? { uri: project.uri, name: project.name } : undefined;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'stale';
}

function labelForAgentRunStatus(status: AgentRunStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'preparing': return '准备中';
    case 'running': return '后台执行中';
    case 'waiting_tool': return '等待工具';
    case 'waiting_child_run': return '等待子任务';
    case 'delivering': return '整理回复';
    case 'paused': return '已暂停';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已终止';
    case 'stale': return '已过期';
  }
}
