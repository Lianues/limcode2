import type { WorldReader } from '../ecs/types';
import type { ConversationRunHistorySaveMode, StorageCapability } from '../capabilities/types';
import { StorageStateContributorsKey } from '../world/storageProjection/resources';
import { projectStorageStateWithCache, type StorageContributorProjectionState } from '../world/storageProjection/projection';
import type { AgentRunStatus, ClientState, MessageContent, MessageRecord, SidebarConversationHistoryEntry } from '../../shared/protocol';
import { conversationCreatedAtFromId, displayConversationTitle } from '../../shared/conversationTitle';
import { conversationRenderDetailSlice, conversationRunHistorySlice } from '../capabilities/vscodeStorage/clientStateStore';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_HISTORY_PERSIST_DEBOUNCE_MS = 80;

const RUN_HISTORY_TABLE_KEYS = [
  'agentRuns',
  'agentRunSourceLinks',
  'agentRunTargetLinks',
  'messageRunLinks',
  'toolCallRunLinks',
  'runConversationPolicies',
  'runContextPolicies',
  'runDeliveryPolicies',
  'runEditPolicies',
  'runModeLinks',
  'runSystemPromptLinks',
  'runModelProfileLinks',
  'runToolPolicyLinks',
  'runConversationPolicyLinks',
  'runContextPolicyLinks',
  'runDeliveryPolicyLinks',
  'runEditPolicyLinks',
  'runWorkEnvironmentLinks',
  'agentRunInputRevisions'
] as const;

export interface ClientStatePersistenceOptions {
  isConversationRenderDetailLoaded?: (conversationId: string) => boolean;
  renderLoadedConversationIds?: () => Iterable<string>;
  isConversationRunHistoryLoaded?: (conversationId: string) => boolean;
  runHistoryLoadedConversationIds?: () => Iterable<string>;
}

interface PendingRunHistoryState {
  readonly state: ClientState;
  readonly mode: ConversationRunHistorySaveMode;
}

/**
 * Storage 持久化使用独立投影缓存。懒加载后必须把骨架、聊天渲染详情与运行历史分开保存，
 * 避免普通聊天只加载 messages/toolCalls 时把未加载的 runHistory index 覆盖为空。
 */
export class ClientStatePersistence {
  private enabled = false;
  private lastPersistedSkeletonJson = '';
  private pendingSkeletonState: ClientState | undefined;
  private readonly lastPersistedRenderDetailJson = new Map<string, string>();
  private readonly lastPersistedRunHistoryJson = new Map<string, string>();
  private readonly pendingRenderDetailStates = new Map<string, ClientState>();
  private readonly pendingRunHistoryStates = new Map<string, PendingRunHistoryState>();
  private readonly pendingHistoryStates = new Map<string, ClientState>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private historyPersistTimer: ReturnType<typeof setTimeout> | undefined;
  private historyPersistInFlight = false;

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
    this.lastPersistedRenderDetailJson.clear();
    this.lastPersistedRunHistoryJson.clear();
  }

  public queuePersist(): void {
    if (!this.enabled) return;
    const projection = this.projectLatestState();
    if (!projection || !projection.changed) return;
    this.collectPendingStates(projection.state, false);
    this.scheduleHistoryIfPending();
    this.scheduleIfPending();
  }

  public async persistImmediately(options: { force?: boolean; throwOnError?: boolean } = {}): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.historyPersistTimer) {
      clearTimeout(this.historyPersistTimer);
      this.historyPersistTimer = undefined;
    }

    const latestState = this.projectLatestState()?.state ?? this.lastProjectedState;
    if (!this.enabled || !latestState) return;

    this.collectPendingStates(latestState, !!options.force);
    if (!this.pendingSkeletonState && this.pendingRenderDetailStates.size === 0 && this.pendingRunHistoryStates.size === 0 && this.pendingHistoryStates.size === 0) return;

    const skeletonState = this.pendingSkeletonState;
    const renderDetailStates = [...this.pendingRenderDetailStates.entries()];
    const runHistoryStates = [...this.pendingRunHistoryStates.entries()];
    const historyStates = [...this.pendingHistoryStates.entries()];
    this.pendingSkeletonState = undefined;
    this.pendingRenderDetailStates.clear();
    this.pendingRunHistoryStates.clear();
    this.pendingHistoryStates.clear();

    try {
      if (skeletonState) {
        await this.storage.saveClientStateSkeleton(skeletonState);
        this.lastPersistedSkeletonJson = JSON.stringify(skeletonPersistenceSlice(skeletonState));
      }

      for (const [conversationId, state] of renderDetailStates) {
        await this.storage.saveConversationRenderDetail(conversationId, state);
        this.lastPersistedRenderDetailJson.set(conversationId, JSON.stringify(conversationRenderDetailSlice(state, conversationId)));
      }

      for (const [conversationId, pending] of runHistoryStates) {
        await this.storage.saveConversationRunHistory(conversationId, pending.state, { mode: pending.mode });
        this.lastPersistedRunHistoryJson.set(conversationId, JSON.stringify(conversationRunHistorySlice(pending.state, conversationId)));
      }

      await this.persistHistoryEntries(historyStates);
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

    for (const conversationId of this.renderLoadedConversationIds(state)) {
      const detail = conversationRenderDetailSlice(state, conversationId);
      const detailJson = JSON.stringify(detail);
      if (!force && detailJson === this.lastPersistedRenderDetailJson.get(conversationId)) continue;
      this.pendingRenderDetailStates.set(conversationId, state);
      this.pendingHistoryStates.set(conversationId, state);
    }

    const replaceRunHistoryIds = new Set(this.runHistoryLoadedConversationIds(state));
    for (const conversationId of replaceRunHistoryIds) {
      this.collectPendingRunHistoryState(state, conversationId, 'replace', force, true);
    }

    for (const conversationId of knownRunHistoryConversationIds(state)) {
      if (replaceRunHistoryIds.has(conversationId)) continue;
      this.collectPendingRunHistoryState(state, conversationId, 'merge', force, false);
    }
  }

  private collectPendingRunHistoryState(
    state: ClientState,
    conversationId: string,
    mode: ConversationRunHistorySaveMode,
    force: boolean,
    allowEmpty: boolean
  ): void {
    const detail = conversationRunHistorySlice(state, conversationId);
    if (!allowEmpty && !hasRunHistoryRecords(detail)) return;

    const detailJson = JSON.stringify(detail);
    if (!force && detailJson === this.lastPersistedRunHistoryJson.get(conversationId)) return;

    const existing = this.pendingRunHistoryStates.get(conversationId);
    if (existing?.mode === 'replace') return;
    this.pendingRunHistoryStates.set(conversationId, { state, mode });
    this.pendingHistoryStates.set(conversationId, state);
  }

  private renderLoadedConversationIds(state: ClientState): string[] {
    const explicit = this.options.renderLoadedConversationIds?.();
    if (explicit) {
      const ids = new Set(uniqueIds(explicit).filter((id) => this.options.isConversationRenderDetailLoaded?.(id) ?? true));
      // 当前 world 中已经有消息的对话一定是本轮运行创建或已加载的详情，允许保存渲染时间线；避免 run_agent 后台新会话重启后只剩 history 无正文。
      for (const message of state.messages) ids.add(message.conversationId);
      return [...ids];
    }

    const ids = new Set(state.messages.map((message) => message.conversationId));
    for (const conversation of state.conversations) {
      if (this.options.isConversationRenderDetailLoaded?.(conversation.id)) ids.add(conversation.id);
    }
    return [...ids];
  }

  private runHistoryLoadedConversationIds(state: ClientState): string[] {
    const explicit = this.options.runHistoryLoadedConversationIds?.();
    if (explicit) return uniqueIds(explicit).filter((id) => this.options.isConversationRunHistoryLoaded?.(id) ?? true);

    return state.conversations
      .map((conversation) => conversation.id)
      .filter((id) => this.options.isConversationRunHistoryLoaded?.(id) ?? false);
  }

  private scheduleIfPending(): void {
    if (!this.pendingSkeletonState && this.pendingRenderDetailStates.size === 0 && this.pendingRunHistoryStates.size === 0) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { void this.persistImmediately(); }, this.debounceMs);
  }

  private scheduleHistoryIfPending(): void {
    if (this.pendingHistoryStates.size === 0) return;
    if (this.historyPersistTimer || this.historyPersistInFlight) return;
    this.historyPersistTimer = setTimeout(() => {
      void this.persistHistoryImmediately();
    }, DEFAULT_HISTORY_PERSIST_DEBOUNCE_MS);
  }

  private async persistHistoryImmediately(): Promise<void> {
    if (this.historyPersistTimer) {
      clearTimeout(this.historyPersistTimer);
      this.historyPersistTimer = undefined;
    }
    if (this.historyPersistInFlight || this.pendingHistoryStates.size === 0) return;

    const historyStates = [...this.pendingHistoryStates.entries()];
    this.pendingHistoryStates.clear();
    this.historyPersistInFlight = true;

    try {
      await this.persistHistoryEntries(historyStates);
    } catch (error) {
      console.warn('[LimCode] Failed to persist conversation history projection:', error);
    } finally {
      this.historyPersistInFlight = false;
      this.scheduleHistoryIfPending();
    }
  }

  private async persistHistoryEntries(historyStates: Array<[string, ClientState]>): Promise<void> {
    for (const [conversationId, state] of historyStates) {
      const entry = projectConversationHistoryEntry(state, conversationId);
      if (entry) await this.storage.upsertConversationHistoryEntry(entry);
    }
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
    runConversationPolicyLinks: [],
    runContextPolicyLinks: [],
    runDeliveryPolicyLinks: [],
    runEditPolicyLinks: [],
    agentRunInputRevisions: []
  };
}

function knownRunHistoryConversationIds(state: ClientState): string[] {
  const ids = new Set<string>();
  const messageConversationIds = new Map(state.messages.map((message) => [message.id, message.conversationId]));
  const toolCallMessageIds = new Map(state.toolCalls.map((toolCall) => [toolCall.id, toolCall.messageId]));

  for (const link of state.agentRunTargetLinks) addId(ids, link.conversationId);
  for (const link of state.agentRunSourceLinks) addId(ids, link.sourceConversationId);
  for (const link of state.messageRunLinks) addId(ids, messageConversationIds.get(link.messageId));
  for (const link of state.toolCallRunLinks) addId(ids, conversationIdForToolCall(link.toolCallId, toolCallMessageIds, messageConversationIds));
  for (const input of state.agentRunInputRevisions) addId(ids, input.conversationId);
  for (const policy of state.runConversationPolicies) {
    addId(ids, policy.conversationId);
    addId(ids, policy.branchFromConversationId);
  }
  for (const policy of state.runDeliveryPolicies) addId(ids, policy.targetConversationId);

  return [...ids];
}

function conversationIdForToolCall(toolCallId: string, toolCallMessageIds: ReadonlyMap<string, string>, messageConversationIds: ReadonlyMap<string, string>): string | undefined {
  const messageId = toolCallMessageIds.get(toolCallId);
  return messageId ? messageConversationIds.get(messageId) : undefined;
}

function hasRunHistoryRecords(state: ClientState): boolean {
  return RUN_HISTORY_TABLE_KEYS.some((key) => state[key].length > 0);
}

function uniqueIds(ids: Iterable<string>): string[] {
  const result = new Set<string>();
  for (const id of ids) addId(result, id);
  return [...result];
}

function addId(target: Set<string>, id: string | undefined): void {
  if (id) target.add(id);
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
  const origin = originInfoForConversation(state, conversationId);
  const title = displayConversationTitle({ id: conversation.id, title: conversation.title, messages });
  const fallbackUpdatedAt = conversationCreatedAtFromId(conversation.id);
  const preview = latest ? messagePreview(latest) : '暂无消息，点击开始新的交流。';
  const entry: SidebarConversationHistoryEntry = {
    id: conversation.id,
    title,
    preview,
    messageCount: messages.length,
    status: latest?.status ?? 'empty',
    isRunning: !!runSummary,
    ...(latest ? { updatedAt: latest.createdAt } : fallbackUpdatedAt !== undefined ? { updatedAt: fallbackUpdatedAt } : {}),
    ...(agentNameForConversation(state, conversationId) ? { agentName: agentNameForConversation(state, conversationId) } : {}),
    ...(project?.uri ? { projectFolderUri: project.uri } : {}),
    ...(project?.name ? { projectName: project.name } : {}),
    ...(origin?.originKind ? { originKind: origin.originKind } : {}),
    ...(origin?.originSourceKind ? { originSourceKind: origin.originSourceKind } : {})
  };
  const previewState = latest ? aiPreviewState(latest) : undefined;
  if (previewState) entry.previewState = previewState;
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

function messagePreview(message: MessageRecord): string {
  const text = normalizeText(textPreview(message.content));
  if (text) return truncateText(text, 72);
  const state = aiPreviewState(message);
  return message.role === 'user' ? '用户消息' : state === 'pending' ? '响应中' : '空响应';
}

function aiPreviewState(message: MessageRecord): 'pending' | 'empty' | undefined {
  if (message.role !== 'model' || normalizeText(textPreview(message.content))) return undefined;
  return message.status === 'streaming' ? 'pending' : 'empty';
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

function originInfoForConversation(state: ClientState, conversationId: string): Pick<SidebarConversationHistoryEntry, 'originKind' | 'originSourceKind'> | undefined {
  const origin = state.conversationOriginLinks
    .filter((candidate) => candidate.conversationId === conversationId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
  return origin ? { originKind: origin.originKind, ...(origin.sourceKind ? { originSourceKind: origin.sourceKind } : {}) } : undefined;
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
    case 'running': return '执行中';
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
