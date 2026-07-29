import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorldReader } from '../ecs/types';
import type { ConversationRunHistorySaveMode, StorageCapability } from '../capabilities/types';
import { StorageStateContributorsKey } from '../world/storageProjection/resources';
import { projectStorageStateWithCache, type StorageContributorProjectionState } from '../world/storageProjection/projection';
import type { AgentRunStatus, ClientState, ClientStateTableKey, ConversationOriginLinkRecord, MessageContent, MessageRecord, PersistenceStatusRecord, SidebarConversationHistoryEntry } from '../../shared/protocol';
import { conversationCreatedAtFromId, displayConversationTitle } from '../../shared/conversationTitle';
import { collectChangedClientStateConversationIds } from '../../shared/clientStateConversationScope';
import { createEmptyClientState, isConversationScopeLinkRecord } from '../../shared/clientStateSchema';
import { conversationRenderDetailSlice, conversationRunHistorySlice } from '../capabilities/vscodeStorage/clientStateStore';
import { projectChatState } from '../world/modules/chat/stateProjection';
import { projectToolsRuntimeState } from '../world/modules/tools/stateProjection';
import { checkpointStateProjection } from '../world/modules/checkpoint/stateProjection';
import { projectStateProjection } from '../world/modules/project/stateProjection';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_PERSIST_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const MUTATION_GATE_CONTEXT = 'client-state-persistence:mutation-gate';

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
  'runWorkflowLinks',
  'runSystemPromptLinks',
  'runModelProfileLinks',
  'runToolPolicyLinks',
  'runRuntimeContextSnapshotLinks',
  'runConversationPolicyLinks',
  'runContextPolicyLinks',
  'runDeliveryPolicyLinks',
  'runEditPolicyLinks',
  'llmInvocations',
  'runLlmInvocationLinks',
  'messageLlmInvocationLinks',
  'runWorkEnvironmentLinks',
  'agentRunInputRevisions',
  'runCompressionBlockLinks'
] as const;

export interface ClientStatePersistenceOptions {
  isConversationRenderDetailLoaded?: (conversationId: string) => boolean;
  renderLoadedConversationIds?: () => Iterable<string>;
  isConversationRunHistoryLoaded?: (conversationId: string) => boolean;
  runHistoryLoadedConversationIds?: () => Iterable<string>;
  /**
   * 历史摘要只能由完整聊天渲染详情生成。
   *
   * 仅加载尾部消息用于快速显示时，也需要允许增量保存消息块；但不能用这份
   * partial state 覆盖 conversation-history，否则重启后会把长对话标题/预览/条数
   * 降级成“新对话 / 暂无消息”或尾部工具响应。
   */
  isConversationHistorySummaryComplete?: (conversationId: string) => boolean;
  /** 测试/宿主可覆盖；默认直接从 ECS 投影目标 conversation 的 timeline-only 数据。 */
  projectConversationTimelineState?: (world: WorldReader, conversationId: string) => ClientState;
  onStatusChange?: (status: PersistenceStatusRecord) => void;
  /** 测试可缩短；生产默认 250ms / 1s / 3s，耗尽后保留 error 状态等待下一次变更。 */
  retryDelaysMs?: readonly number[];
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
  private persistTimerDueAt: number | undefined;
  private queuedPersistDelayMs: number | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private persistenceStatus: PersistenceStatusRecord = {
    phase: 'pending',
    updatedAt: Date.now(),
    pendingSince: Date.now()
  };
  private persistInFlight = false;
  private persistPendingAfterInFlight = false;
  private readonly persistIdleWaiters: Array<() => void> = [];
  private mutationGateActive = false;
  private mutationGateTail: Promise<void> = Promise.resolve();
  private persistPendingAfterMutationGate = false;
  private readonly mutationGateIdleWaiters: Array<() => void> = [];
  private readonly mutationGateContext = new AsyncLocalStorage<string>();

  private projectionClock = '';
  private contributorStates: Record<string, StorageContributorProjectionState> = {};
  private lastProjectedState: ClientState | undefined;

  public constructor(
    private readonly world: WorldReader,
    private readonly storage: StorageCapability,
    private readonly options: ClientStatePersistenceOptions = {},
    private readonly debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS
  ) {}

  public enable(): void {
    this.enabled = true;
    this.emitStatus();
  }

  public statusSnapshot(): PersistenceStatusRecord {
    return { ...this.persistenceStatus };
  }

  public markUnavailable(error: unknown): void {
    this.clearPersistTimer();
    this.clearRetryTimer();
    this.queuedPersistDelayMs = undefined;
    this.setPersistenceStatus({
      phase: 'error',
      error: persistenceErrorMessage(error)
    });
  }

  public rememberPersistedState(state: ClientState): void {
    this.lastPersistedSkeletonJson = JSON.stringify(skeletonPersistenceSlice(state));
    this.lastProjectedState = state;
    this.projectionClock = '';
    this.contributorStates = {};
    this.lastPersistedRenderDetailJson.clear();
    this.lastPersistedRunHistoryJson.clear();
    this.markSaved();
  }

  /** 记录刚从 storage 完整读取且未被修补的 render detail，避免 hydrate 本身触发重复回写。 */
  public rememberConversationRenderDetailPersisted(conversationId: string, state: ClientState): void {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;
    this.lastPersistedRenderDetailJson.set(
      normalizedConversationId,
      JSON.stringify(conversationRenderDetailSlice(state, normalizedConversationId))
    );
  }

  public queuePersist(options: { delayMs?: number } = {}): void {
    if (!this.enabled) return;
    this.clearRetryTimer();
    if (this.persistenceStatus.phase === 'error') this.retryAttempt = 0;
    const requestedDelay = normalizeDelayMs(options.delayMs, this.debounceMs);
    this.queuedPersistDelayMs = this.queuedPersistDelayMs === undefined
      ? requestedDelay
      : Math.min(this.queuedPersistDelayMs, requestedDelay);
    if (this.persistInFlight) {
      this.persistPendingAfterInFlight = true;
      return;
    }
    this.markPending();
    if (this.mutationGateActive) {
      this.persistPendingAfterMutationGate = true;
      return;
    }
    this.schedulePersistCheck();
  }

  public async persistImmediately(options: { force?: boolean; ensurePersisted?: boolean; forceConversationId?: string; throwOnError?: boolean } = {}): Promise<void> {
    this.clearPersistTimer();
    this.clearRetryTimer();

    if (this.mutationGateActive && !this.isInsideMutationGate()) {
      this.persistPendingAfterMutationGate = true;
      this.markPending();
      await this.waitForMutationGateIdle();
      return this.persistImmediately(options);
    }

    if (this.persistInFlight) {
      this.persistPendingAfterInFlight = true;
      this.markPending();
      await this.waitForPersistIdle();
      return this.persistImmediately(options);
    }

    this.queuedPersistDelayMs = undefined;
    const latest = this.projectLatestState();
    const forcedConversationId = options.forceConversationId?.trim();
    const latestState = latest?.state ?? this.lastProjectedState;
    if (!options.force && !options.ensurePersisted && !forcedConversationId && latest && !latest.changed && !this.hasPendingStates()) {
      this.markSavedIfIdle();
      return;
    }

    if (!this.enabled || !latestState) return;

    const targetConversationIds = options.force || options.ensurePersisted
      ? undefined
      : latest?.previousState
        ? collectChangedClientStateConversationIds(latest.previousState, latestState, latest.changedTableKeys)
        : undefined;
    this.collectPendingStates(latestState, !!options.force, targetConversationIds);
    if (forcedConversationId) this.collectForcedConversationState(latestState, forcedConversationId);
    if (!this.pendingSkeletonState && this.pendingRenderDetailStates.size === 0 && this.pendingRunHistoryStates.size === 0 && this.pendingHistoryStates.size === 0) {
      this.markSavedIfIdle();
      return;
    }

    const skeletonState = this.pendingSkeletonState;
    const renderDetailStates = [...this.pendingRenderDetailStates.entries()];
    const runHistoryStates = [...this.pendingRunHistoryStates.entries()];
    const historyStates = [...this.pendingHistoryStates.entries()];
    this.pendingSkeletonState = undefined;
    this.pendingRenderDetailStates.clear();
    this.pendingRunHistoryStates.clear();
    this.pendingHistoryStates.clear();

    this.persistInFlight = true;
    this.setPersistenceStatus({
      phase: 'saving',
      pendingSince: this.persistenceStatus.pendingSince ?? Date.now()
    });
    let persistSucceeded = false;
    let persistenceFailure: unknown;
    let shouldRetry = false;
    // 先启动 render detail 保存，让每个 conversation 立即预订自己的 timeline root FIFO。
    // 后续消息 truncate 会排在这些旧快照之后，而不会被 skeleton/run-history 慢任务拖到旧快照前面。
    const renderDetailTask = awaitAllPersistTasks(renderDetailStates.map(async ([conversationId, state]) => {
      await this.storage.saveConversationRenderDetail(conversationId, state);
      this.lastPersistedRenderDetailJson.set(conversationId, JSON.stringify(conversationRenderDetailSlice(state, conversationId)));
    }));
    const skeletonTask = skeletonState
      ? this.storage.saveClientStateSkeleton(skeletonState).then(() => {
          this.lastPersistedSkeletonJson = JSON.stringify(skeletonPersistenceSlice(skeletonState));
        })
      : Promise.resolve();
    try {
      // render 与 skeleton 并行；render 已先创建，因此会先预订 conversation timeline 队列。
      await Promise.all([renderDetailTask, skeletonTask]);

      // 每个 conversation 使用独立存储目录，可并行落盘；共享 history index 仍在下方串行更新。

      await awaitAllPersistTasks(runHistoryStates.map(async ([conversationId, pending]) => {
        await this.storage.saveConversationRunHistory(conversationId, pending.state, { mode: pending.mode });
        this.lastPersistedRunHistoryJson.set(conversationId, JSON.stringify(conversationRunHistorySlice(pending.state, conversationId)));
      }));

      await this.persistHistoryEntries(historyStates);
      persistSucceeded = true;
      this.retryAttempt = 0;
    } catch (error) {
      persistenceFailure = error;
      shouldRetry = !options.throwOnError;
      this.restorePendingStates(skeletonState, renderDetailStates, runHistoryStates, historyStates);
      this.setPersistenceStatus({
        phase: 'error',
        error: persistenceErrorMessage(error),
        pendingSince: this.persistenceStatus.pendingSince ?? Date.now()
      });
      console.warn('[LimCode] Failed to persist client state:', error);
      if (options.throwOnError) throw error;
    } finally {
      this.persistInFlight = false;
      this.resolvePersistIdleWaiters();
      if (this.persistPendingAfterInFlight) {
        this.persistPendingAfterInFlight = false;
        this.markPending();
        this.schedulePersistCheck();
      } else if (persistSucceeded) {
        this.markSaved();
      } else if (shouldRetry) {
        this.scheduleRetryAfterFailure(persistenceFailure);
      }
    }
  }

  /**
   * 只强制保存一个 conversation 的聊天渲染时间线。
   *
   * 消息编辑/删除/重试只依赖 messages/revisions/tool/checkpoint timeline 已落盘，
   * 不应等待全局 skeleton、run history、history summary 或其他 conversation。
   * 底层 timeline root lock 会与普通后台 render 保存保持 FIFO 顺序。
   */
  public async persistConversationRenderDetailImmediately(
    conversationId: string,
    options: { throwOnError?: boolean } = {}
  ): Promise<void> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || !this.enabled) return;

    if (this.mutationGateActive && !this.isInsideMutationGate()) {
      this.persistPendingAfterMutationGate = true;
      await this.waitForMutationGateIdle();
      return this.persistConversationRenderDetailImmediately(normalizedConversationId, options);
    }

    const state = this.options.projectConversationTimelineState?.(this.world, normalizedConversationId)
      ?? projectConversationTimelineState(this.world, normalizedConversationId);

    try {
      await this.storage.saveConversationTimelineRenderDetail(normalizedConversationId, state);
      this.lastPersistedRenderDetailJson.set(normalizedConversationId, JSON.stringify(state));
    } catch (error) {
      console.warn(`[LimCode] Failed to persist conversation timeline before mutation: ${normalizedConversationId}`, error);
      if (options.throwOnError) throw error;
    }
  }

  /**
   * 在读取完整 conversation timeline 前，先提交当前 ECS 中已 hydrate 的 timeline 变更。
   *
   * 复用独占持久化屏障，确保 debounce writer 不会在完整 reader 读取 generation 的过程中
   * 发布新 index；提交失败会直接阻止后续读取和模型调用。
   */
  public async withConversationTimelineCommittedBeforeRead<T>(
    conversationId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || !this.enabled) return action();
    return this.withExclusiveMutationGate(async () => {
      await this.persistConversationRenderDetailImmediately(normalizedConversationId, { throwOnError: true });
      return action();
    });
  }

  /**
   * 独占生命周期变更屏障：阻止新的普通持久化启动，等待已开始的持久化完成，
   * 并允许屏障内部显式调用 persistImmediately 安全落盘。
   */
  public async withExclusiveMutationGate<T>(action: () => Promise<T>): Promise<T> {
    const previousGate = this.mutationGateTail;
    let releaseGate!: () => void;
    const currentGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    this.mutationGateTail = previousGate.catch(() => undefined).then(() => currentGate);

    await previousGate.catch(() => undefined);

    this.mutationGateActive = true;
    if (this.persistTimer) {
      this.persistPendingAfterMutationGate = true;
      const remainingMs = Math.max(0, (this.persistTimerDueAt ?? Date.now()) - Date.now());
      this.queuedPersistDelayMs = this.queuedPersistDelayMs === undefined
        ? remainingMs
        : Math.min(this.queuedPersistDelayMs, remainingMs);
      this.markPending();
    }
    this.clearPersistTimer();
    await this.waitForPersistIdle();

    try {
      return await this.mutationGateContext.run(MUTATION_GATE_CONTEXT, action);
    } finally {
      this.mutationGateActive = false;
      releaseGate();
      this.resolveMutationGateIdleWaiters();
      if (this.persistPendingAfterMutationGate) {
        this.persistPendingAfterMutationGate = false;
        this.markPending();
        this.schedulePersistCheck();
      }
    }
  }

  public discardConversation(conversationId: string): void {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;

    this.pendingRenderDetailStates.delete(normalizedConversationId);
    this.pendingRunHistoryStates.delete(normalizedConversationId);
    this.pendingHistoryStates.delete(normalizedConversationId);
    this.lastPersistedRenderDetailJson.delete(normalizedConversationId);
    this.lastPersistedRunHistoryJson.delete(normalizedConversationId);

    if (this.pendingSkeletonState) {
      this.pendingSkeletonState = stripConversationFromClientState(this.pendingSkeletonState, normalizedConversationId);
    }
    if (this.lastProjectedState) {
      this.lastProjectedState = stripConversationFromClientState(this.lastProjectedState, normalizedConversationId);
    }
    this.lastPersistedSkeletonJson = this.lastProjectedState
      ? JSON.stringify(skeletonPersistenceSlice(this.lastProjectedState))
      : stripConversationFromSkeletonJson(this.lastPersistedSkeletonJson, normalizedConversationId);
  }

  private hasPendingStates(): boolean {
    return !!this.pendingSkeletonState
      || this.pendingRenderDetailStates.size > 0
      || this.pendingRunHistoryStates.size > 0
      || this.pendingHistoryStates.size > 0;
  }

  private restorePendingStates(
    skeletonState: ClientState | undefined,
    renderDetailStates: Array<[string, ClientState]>,
    runHistoryStates: Array<[string, PendingRunHistoryState]>,
    historyStates: Array<[string, ClientState]>
  ): void {
    if (skeletonState && !this.pendingSkeletonState) this.pendingSkeletonState = skeletonState;
    for (const [conversationId, state] of renderDetailStates) {
      if (!this.pendingRenderDetailStates.has(conversationId)) this.pendingRenderDetailStates.set(conversationId, state);
    }
    for (const [conversationId, state] of runHistoryStates) {
      if (!this.pendingRunHistoryStates.has(conversationId)) this.pendingRunHistoryStates.set(conversationId, state);
    }
    for (const [conversationId, state] of historyStates) {
      if (!this.pendingHistoryStates.has(conversationId)) this.pendingHistoryStates.set(conversationId, state);
    }
  }

  private collectPendingStates(state: ClientState, force: boolean, targetConversationIds?: ReadonlySet<string>): void {
    const skeletonJson = JSON.stringify(skeletonPersistenceSlice(state));
    if (force || skeletonJson !== this.lastPersistedSkeletonJson) {
      this.pendingSkeletonState = state;
    }

    for (const conversationId of this.renderLoadedConversationIds(state)) {
      if (targetConversationIds && !targetConversationIds.has(conversationId)) continue;
      const detail = conversationRenderDetailSlice(state, conversationId);
      const detailJson = JSON.stringify(detail);
      if (!force && detailJson === this.lastPersistedRenderDetailJson.get(conversationId)) continue;
      this.pendingRenderDetailStates.set(conversationId, state);
      if (this.shouldPersistHistorySummary(conversationId)) {
        this.pendingHistoryStates.set(conversationId, state);
      }
    }

    const replaceRunHistoryIds = new Set(this.runHistoryLoadedConversationIds(state));
    for (const conversationId of replaceRunHistoryIds) {
      if (targetConversationIds && !targetConversationIds.has(conversationId)) continue;
      this.collectPendingRunHistoryState(state, conversationId, 'replace', force, true);
    }

    for (const conversationId of knownRunHistoryConversationIds(state)) {
      if (targetConversationIds && !targetConversationIds.has(conversationId)) continue;
      if (replaceRunHistoryIds.has(conversationId)) continue;
      this.collectPendingRunHistoryState(state, conversationId, 'merge', force, false);
    }
  }

  private collectForcedConversationState(state: ClientState, conversationId: string): void {
    if (this.renderLoadedConversationIds(state).includes(conversationId)) {
      this.pendingRenderDetailStates.set(conversationId, state);
      if (this.shouldPersistHistorySummary(conversationId)) {
        this.pendingHistoryStates.set(conversationId, state);
      }
    }

    if (this.runHistoryLoadedConversationIds(state).includes(conversationId)) {
      this.pendingRunHistoryStates.set(conversationId, { state, mode: 'replace' });
      this.pendingHistoryStates.set(conversationId, state);
      return;
    }

    if (knownRunHistoryConversationIds(state).includes(conversationId)) {
      const detail = conversationRunHistorySlice(state, conversationId);
      if (hasRunHistoryRecords(detail)) {
        this.pendingRunHistoryStates.set(conversationId, { state, mode: 'merge' });
        this.pendingHistoryStates.set(conversationId, state);
      }
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

    const shouldCompareJson = !force;
    if (shouldCompareJson) {
      const detailJson = JSON.stringify(detail);
      if (detailJson === this.lastPersistedRunHistoryJson.get(conversationId)) return;
    }

    const existing = this.pendingRunHistoryStates.get(conversationId);
    if (existing?.mode === 'replace') return;
    this.pendingRunHistoryStates.set(conversationId, { state, mode });
    if (this.shouldPersistHistorySummary(conversationId)) {
      this.pendingHistoryStates.set(conversationId, state);
    }
  }

  private shouldPersistHistorySummary(conversationId: string): boolean {
    return this.options.isConversationHistorySummaryComplete?.(conversationId) ?? true;
  }

  private renderLoadedConversationIds(state: ClientState): string[] {
    const explicit = this.options.renderLoadedConversationIds?.();
    if (explicit) {
      const ids = new Set(uniqueIds(explicit).filter((id) => this.options.isConversationRenderDetailLoaded?.(id) ?? true));
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

  private schedulePersistCheck(): void {
    if (this.mutationGateActive) {
      this.persistPendingAfterMutationGate = true;
      return;
    }
    if (this.persistInFlight) {
      this.persistPendingAfterInFlight = true;
      return;
    }

    const delayMs = this.queuedPersistDelayMs ?? this.debounceMs;
    const dueAt = Date.now() + delayMs;
    if (this.persistTimer && this.persistTimerDueAt !== undefined && this.persistTimerDueAt <= dueAt) {
      this.queuedPersistDelayMs = undefined;
      return;
    }

    this.clearPersistTimer();
    this.queuedPersistDelayMs = undefined;
    this.persistTimerDueAt = dueAt;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistTimerDueAt = undefined;
      void this.persistImmediately();
    }, Math.max(0, dueAt - Date.now()));
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persistTimerDueAt = undefined;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetryAfterFailure(error: unknown): void {
    const delays = this.options.retryDelaysMs ?? DEFAULT_PERSIST_RETRY_DELAYS_MS;
    const delayMs = normalizeRetryDelayMs(delays[this.retryAttempt]);
    if (delayMs === undefined) return;

    this.retryAttempt += 1;
    const nextRetryAt = Date.now() + delayMs;
    this.setPersistenceStatus({
      phase: 'error',
      error: persistenceErrorMessage(error),
      pendingSince: this.persistenceStatus.pendingSince ?? Date.now(),
      retryAttempt: this.retryAttempt,
      nextRetryAt
    });
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.persistImmediately();
    }, delayMs);
  }

  private markPending(): void {
    const now = Date.now();
    this.setPersistenceStatus({
      phase: 'pending',
      pendingSince: this.persistenceStatus.pendingSince ?? now
    });
  }

  private markSavedIfIdle(): void {
    if (this.persistInFlight || this.persistTimer || this.retryTimer || this.mutationGateActive || this.hasPendingStates()) return;
    this.markSaved();
  }

  private markSaved(): void {
    const now = Date.now();
    this.setPersistenceStatus({ phase: 'saved', lastSavedAt: now });
  }

  private setPersistenceStatus(next: Omit<PersistenceStatusRecord, 'updatedAt'>): void {
    const lastSavedAt = next.lastSavedAt ?? this.persistenceStatus.lastSavedAt;
    const candidate: PersistenceStatusRecord = {
      ...next,
      updatedAt: this.persistenceStatus.updatedAt,
      ...(lastSavedAt !== undefined ? { lastSavedAt } : {})
    };
    if (samePersistenceStatus(this.persistenceStatus, candidate)) return;
    this.persistenceStatus = { ...candidate, updatedAt: Date.now() };
    this.emitStatus();
  }

  private emitStatus(): void {
    try {
      this.options.onStatusChange?.({ ...this.persistenceStatus });
    } catch (error) {
      console.warn('[LimCode] Failed to publish persistence status:', error);
    }
  }

  private waitForPersistIdle(): Promise<void> {
    if (!this.persistInFlight) return Promise.resolve();
    return new Promise((resolve) => {
      this.persistIdleWaiters.push(resolve);
    });
  }

  private waitForMutationGateIdle(): Promise<void> {
    if (!this.mutationGateActive) return Promise.resolve();
    return new Promise((resolve) => {
      this.mutationGateIdleWaiters.push(resolve);
    });
  }

  private resolvePersistIdleWaiters(): void {
    const waiters = this.persistIdleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private resolveMutationGateIdleWaiters(): void {
    const waiters = this.mutationGateIdleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private isInsideMutationGate(): boolean {
    return this.mutationGateContext.getStore() === MUTATION_GATE_CONTEXT;
  }

  private async persistHistoryEntries(historyStates: Array<[string, ClientState]>): Promise<void> {
    for (const [conversationId, state] of historyStates) {
      const entry = projectConversationHistoryEntry(state, conversationId);
      if (entry) await this.storage.upsertConversationHistoryEntry(entry, originLinkForConversation(state, conversationId));
    }
  }

  private projectLatestState(): { state: ClientState; changed: boolean; previousState?: ClientState; changedTableKeys?: readonly ClientStateTableKey[] } | undefined {
    const previousState = this.lastProjectedState;
    const registry = this.world.tryGetResource(StorageStateContributorsKey);
    if (!registry) return previousState ? { state: previousState, changed: false, previousState } : undefined;

    const projection = projectStorageStateWithCache(this.world, registry.list(), {
      projectionClock: this.projectionClock,
      contributorStates: this.contributorStates
    });
    this.projectionClock = projection.projectionClock;
    this.contributorStates = projection.contributorStates;
    this.lastProjectedState = projection.state;
    return {
      state: projection.state,
      changed: projection.changed,
      previousState,
      changedTableKeys: changedStorageTableKeys(projection.changedContributorKeys, projection.contributorStates)
    };
  }
}

async function awaitAllPersistTasks(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function changedStorageTableKeys(
  changedContributorKeys: readonly string[],
  contributorStates: Record<string, StorageContributorProjectionState>
): readonly ClientStateTableKey[] | undefined {
  if (changedContributorKeys.length === 0) return undefined;
  const tableKeys = new Set<ClientStateTableKey>();
  for (const key of changedContributorKeys) {
    const slice = contributorStates[key]?.slice;
    const keys = slice ? Object.keys(slice) as ClientStateTableKey[] : [];
    if (keys.length === 0) return undefined;
    for (const tableKey of keys) tableKeys.add(tableKey);
  }
  return [...tableKeys];
}

function skeletonPersistenceSlice(state: ClientState): ClientState {
  return {
    ...state,
    checkpoints: state.checkpoints.filter((checkpoint) => checkpoint.status !== 'pending'),
    checkpointTimelineAnchors: state.checkpointTimelineAnchors.filter((anchor) => state.checkpoints.some((checkpoint) => checkpoint.id === anchor.checkpointId && checkpoint.status !== 'pending')),
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
    runWorkflowLinks: [],
    runSystemPromptLinks: [],
    runModelProfileLinks: [],
    runToolPolicyLinks: [],
    runRuntimeContextSnapshotLinks: [],
    runConversationPolicyLinks: [],
    runContextPolicyLinks: [],
    runDeliveryPolicyLinks: [],
    runEditPolicyLinks: [],
    llmInvocations: [],
    runLlmInvocationLinks: [],
    messageLlmInvocationLinks: [],
    agentRunInputRevisions: [],
    compressionBlocks: [],
    compressionBlockSourceLinks: [],
    compressionContextVariants: [],
    compressionBlockLlmInvocationLinks: [],
    runCompressionBlockLinks: []
  };
}

function stripConversationFromSkeletonJson(json: string, conversationId: string): string {
  if (!json) return '';
  try {
    return JSON.stringify(skeletonPersistenceSlice(stripConversationFromClientState(JSON.parse(json) as ClientState, conversationId)));
  } catch {
    return '';
  }
}

function stripConversationFromClientState(state: ClientState, conversationId: string): ClientState {
  const removedMessageIds = new Set(state.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const removedRevisionIds = new Set(state.messageRevisions.filter((revision) => revision.conversationId === conversationId || removedMessageIds.has(revision.messageId)).map((revision) => revision.id));
  const removedToolCallIds = new Set(state.toolCalls.filter((toolCall) => removedMessageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  const removedCompressionBlockIds = new Set(state.compressionBlocks.filter((block) => block.conversationId === conversationId).map((block) => block.id));
  const removedCheckpointIds = new Set(state.checkpoints.filter((checkpoint) => checkpoint.conversationId === conversationId).map((checkpoint) => checkpoint.id));
  for (const anchor of state.checkpointTimelineAnchors) {
    if (anchor.conversationId === conversationId) removedCheckpointIds.add(anchor.checkpointId);
  }

  const removedRunIds = new Set<string>();
  for (const link of state.agentRunTargetLinks) if (link.conversationId === conversationId) removedRunIds.add(link.runId);
  for (const link of state.agentRunSourceLinks) {
    if (link.sourceConversationId === conversationId || (link.sourceMessageId && removedMessageIds.has(link.sourceMessageId)) || (link.sourceToolCallId && removedToolCallIds.has(link.sourceToolCallId))) {
      removedRunIds.add(link.runId);
    }
    if (link.sourceRunId && removedRunIds.has(link.sourceRunId)) removedRunIds.add(link.runId);
  }
  for (const link of state.messageRunLinks) if (removedMessageIds.has(link.messageId)) removedRunIds.add(link.runId);
  for (const link of state.toolCallRunLinks) if (removedToolCallIds.has(link.toolCallId)) removedRunIds.add(link.runId);
  for (const input of state.agentRunInputRevisions) if (input.conversationId === conversationId || removedRevisionIds.has(input.revisionId)) removedRunIds.add(input.runId);
  for (const link of state.runCompressionBlockLinks) if (removedCompressionBlockIds.has(link.blockId)) removedRunIds.add(link.runId);

  const removedConversationPolicyIds = new Set(state.runConversationPolicies.filter((policy) => policy.conversationId === conversationId || policy.branchFromConversationId === conversationId).map((policy) => policy.id));
  for (const link of state.runConversationPolicyLinks) if (removedRunIds.has(link.runId)) removedConversationPolicyIds.add(link.policyId);
  const removedContextPolicyIds = new Set(state.runContextPolicyLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.policyId));
  const removedDeliveryPolicyIds = new Set(state.runDeliveryPolicyLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.policyId));
  for (const policy of state.runDeliveryPolicies) if (policy.targetConversationId === conversationId || (policy.targetToolCallId && removedToolCallIds.has(policy.targetToolCallId))) removedDeliveryPolicyIds.add(policy.id);
  const removedEditPolicyIds = new Set(state.runEditPolicyLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.policyId));

  const removedInvocationIds = new Set<string>();
  for (const link of state.runLlmInvocationLinks) if (removedRunIds.has(link.runId)) removedInvocationIds.add(link.invocationId);
  for (const link of state.messageLlmInvocationLinks) if (removedMessageIds.has(link.messageId)) removedInvocationIds.add(link.invocationId);
  for (const link of state.compressionBlockLlmInvocationLinks) if (removedCompressionBlockIds.has(link.blockId)) removedInvocationIds.add(link.invocationId);

  const removedPlanProposalIds = new Set(state.runPlanProposalLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.planProposalId));
  const planProposalIdsStillReferenced = new Set(state.runPlanProposalLinks.filter((link) => !removedRunIds.has(link.runId)).map((link) => link.planProposalId));

  const repositoryIdsReferencedByDeletedConversation = new Set<string>();
  for (const checkpoint of state.checkpoints) if (removedCheckpointIds.has(checkpoint.id)) repositoryIdsReferencedByDeletedConversation.add(checkpoint.shadowRepositoryId);
  for (const link of state.conversationCheckpointRepositoryLinks) if (link.conversationId === conversationId) repositoryIdsReferencedByDeletedConversation.add(link.shadowRepositoryId);
  const repositoryIdsStillReferenced = new Set<string>();
  for (const checkpoint of state.checkpoints) if (!removedCheckpointIds.has(checkpoint.id)) repositoryIdsStillReferenced.add(checkpoint.shadowRepositoryId);
  for (const link of state.conversationCheckpointRepositoryLinks) if (link.conversationId !== conversationId) repositoryIdsStillReferenced.add(link.shadowRepositoryId);
  const removedShadowRepositoryIds = new Set([...repositoryIdsReferencedByDeletedConversation].filter((id) => !repositoryIdsStillReferenced.has(id)));

  return {
    ...state,
    conversations: state.conversations.filter((conversation) => conversation.id !== conversationId),
    conversationReuseLinks: state.conversationReuseLinks.filter((link) => link.conversationId !== conversationId),
    conversationBranchLinks: state.conversationBranchLinks.filter((link) => link.sourceConversationId !== conversationId && link.targetConversationId !== conversationId),
    conversationOriginLinks: state.conversationOriginLinks.filter((link) => link.conversationId !== conversationId && link.sourceConversationId !== conversationId && !removedRunIds.has(link.sourceRunId ?? '')),
    agentConversationLinks: state.agentConversationLinks.filter((link) => link.conversationId !== conversationId),
    conversationAgentSelections: state.conversationAgentSelections.filter((selection) => selection.conversationId !== conversationId),
    conversationWorkflowSelections: state.conversationWorkflowSelections.filter((selection) => selection.conversationId !== conversationId),
    conversationProjectLinks: state.conversationProjectLinks.filter((link) => link.conversationId !== conversationId),
    conversationWorkEnvironmentLinks: state.conversationWorkEnvironmentLinks.filter((link) => link.conversationId !== conversationId),
    conversationRuntimeContextSnapshotLinks: state.conversationRuntimeContextSnapshotLinks.filter((link) => link.conversationId !== conversationId),
    checkpointPolicyScopeLinks: state.checkpointPolicyScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    workEnvironmentPolicyScopeLinks: state.workEnvironmentPolicyScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    systemPromptScopeLinks: state.systemPromptScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    modelProfileScopeLinks: state.modelProfileScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    runtimeContextScopeLinks: state.runtimeContextScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    planReviewPolicyScopeLinks: state.planReviewPolicyScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    conversationCheckpointRepositoryLinks: state.conversationCheckpointRepositoryLinks.filter((link) => link.conversationId !== conversationId),
    checkpoints: state.checkpoints.filter((checkpoint) => !removedCheckpointIds.has(checkpoint.id)),
    checkpointTimelineAnchors: state.checkpointTimelineAnchors.filter((anchor) => anchor.conversationId !== conversationId && !removedCheckpointIds.has(anchor.checkpointId)),
    shadowRepositories: state.shadowRepositories.filter((repository) => !removedShadowRepositoryIds.has(repository.id)),
    messages: state.messages.filter((message) => message.conversationId !== conversationId),
    messageRevisions: state.messageRevisions.filter((revision) => revision.conversationId !== conversationId && !removedMessageIds.has(revision.messageId)),
    messageCurrentRevisionLinks: state.messageCurrentRevisionLinks.filter((link) => !removedMessageIds.has(link.messageId) && !removedRevisionIds.has(link.revisionId)),
    toolCalls: state.toolCalls.filter((toolCall) => !removedToolCallIds.has(toolCall.id)),
    toolCallEvents: state.toolCallEvents.filter((event) => !removedToolCallIds.has(event.toolCallId)),
    compressionBlocks: state.compressionBlocks.filter((block) => block.conversationId !== conversationId),
    compressionBlockSourceLinks: state.compressionBlockSourceLinks.filter((link) => !removedCompressionBlockIds.has(link.blockId)),
    compressionContextVariants: state.compressionContextVariants.filter((variant) => !removedCompressionBlockIds.has(variant.blockId)),
    runCompressionBlockLinks: state.runCompressionBlockLinks.filter((link) => !removedRunIds.has(link.runId) && !removedCompressionBlockIds.has(link.blockId)),
    runPlanProposalLinks: state.runPlanProposalLinks.filter((link) => !removedRunIds.has(link.runId)),
    planProposals: state.planProposals.filter((proposal) => !removedPlanProposalIds.has(proposal.id) || planProposalIdsStillReferenced.has(proposal.id)),
    compressionBlockLlmInvocationLinks: state.compressionBlockLlmInvocationLinks.filter((link) => !removedCompressionBlockIds.has(link.blockId) && !removedInvocationIds.has(link.invocationId)),
    llmInvocations: state.llmInvocations.filter((invocation) => !removedInvocationIds.has(invocation.id)),
    runLlmInvocationLinks: state.runLlmInvocationLinks.filter((link) => !removedRunIds.has(link.runId) && !removedInvocationIds.has(link.invocationId)),
    messageLlmInvocationLinks: state.messageLlmInvocationLinks.filter((link) => !removedMessageIds.has(link.messageId) && !removedInvocationIds.has(link.invocationId)),
    agentRuns: state.agentRuns.filter((run) => !removedRunIds.has(run.id)),
    agentRunQueueOrders: state.agentRunQueueOrders.filter((order) => !removedRunIds.has(order.runId) && order.conversationId !== conversationId),
    agentRunQueueHolds: state.agentRunQueueHolds.filter((hold) => !removedRunIds.has(hold.runId) && hold.conversationId !== conversationId),
    agentRunQueuedInputs: state.agentRunQueuedInputs.filter((input) => !removedRunIds.has(input.runId) && input.conversationId !== conversationId),
    agentRunSourceLinks: state.agentRunSourceLinks.filter((link) => !removedRunIds.has(link.runId) && !removedRunIds.has(link.sourceRunId ?? '') && link.sourceConversationId !== conversationId && !removedMessageIds.has(link.sourceMessageId ?? '') && !removedToolCallIds.has(link.sourceToolCallId ?? '')),
    agentRunTargetLinks: state.agentRunTargetLinks.filter((link) => !removedRunIds.has(link.runId) && link.conversationId !== conversationId),
    messageRunLinks: state.messageRunLinks.filter((link) => !removedRunIds.has(link.runId) && !removedMessageIds.has(link.messageId)),
    toolCallRunLinks: state.toolCallRunLinks.filter((link) => !removedRunIds.has(link.runId) && !removedToolCallIds.has(link.toolCallId)),
    runConversationPolicies: state.runConversationPolicies.filter((policy) => !removedConversationPolicyIds.has(policy.id)),
    runContextPolicies: state.runContextPolicies.filter((policy) => !removedContextPolicyIds.has(policy.id)),
    runDeliveryPolicies: state.runDeliveryPolicies.filter((policy) => !removedDeliveryPolicyIds.has(policy.id)),
    runEditPolicies: state.runEditPolicies.filter((policy) => !removedEditPolicyIds.has(policy.id)),
    runWorkflowLinks: state.runWorkflowLinks.filter((link) => !removedRunIds.has(link.runId)),
    runSystemPromptLinks: state.runSystemPromptLinks.filter((link) => !removedRunIds.has(link.runId)),
    runModelProfileLinks: state.runModelProfileLinks.filter((link) => !removedRunIds.has(link.runId)),
    runToolPolicyLinks: state.runToolPolicyLinks.filter((link) => !removedRunIds.has(link.runId)),
    runRuntimeContextSnapshotLinks: state.runRuntimeContextSnapshotLinks.filter((link) => !removedRunIds.has(link.runId)),
    runWorkEnvironmentLinks: state.runWorkEnvironmentLinks.filter((link) => !removedRunIds.has(link.runId)),
    runConversationPolicyLinks: state.runConversationPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedConversationPolicyIds.has(link.policyId)),
    runContextPolicyLinks: state.runContextPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedContextPolicyIds.has(link.policyId)),
    runDeliveryPolicyLinks: state.runDeliveryPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedDeliveryPolicyIds.has(link.policyId)),
    runEditPolicyLinks: state.runEditPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedEditPolicyIds.has(link.policyId)),
    agentRunInputRevisions: state.agentRunInputRevisions.filter((input) => !removedRunIds.has(input.runId) && input.conversationId !== conversationId && !removedRevisionIds.has(input.revisionId))
  };
}

function knownRunHistoryConversationIds(state: ClientState): string[] {
  const ids = new Set<string>();
  const messageConversationIds = new Map(state.messages.map((message) => [message.id, message.conversationId]));
  const toolCallMessageIds = new Map(state.toolCalls.map((toolCall) => [toolCall.id, toolCall.messageId]));
  const compressionConversationIds = new Map(state.compressionBlocks.map((block) => [block.id, block.conversationId]));

  for (const link of state.agentRunTargetLinks) addId(ids, link.conversationId);
  for (const link of state.agentRunSourceLinks) addId(ids, link.sourceConversationId);
  for (const link of state.messageRunLinks) addId(ids, messageConversationIds.get(link.messageId));
  for (const link of state.toolCallRunLinks) addId(ids, conversationIdForToolCall(link.toolCallId, toolCallMessageIds, messageConversationIds));
  for (const input of state.agentRunInputRevisions) addId(ids, input.conversationId);
  for (const link of state.runCompressionBlockLinks) addId(ids, compressionConversationIds.get(link.blockId));
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

function projectConversationTimelineState(world: WorldReader, conversationId: string): ClientState {
  const projected = createEmptyClientState();
  const chat = projectChatState(world);
  const tools = projectToolsRuntimeState(world);
  const checkpoints = checkpointStateProjection(world);
  const projects = projectStateProjection(world);
  Object.assign(projected, chat, tools, checkpoints, projects);
  return conversationRenderDetailSlice(projected, conversationId);
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
    ...(project?.name ? { projectName: project.name } : {})
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

function originLinkForConversation(state: ClientState, conversationId: string): ConversationOriginLinkRecord | undefined {
  return state.conversationOriginLinks
    .filter((candidate) => candidate.conversationId === conversationId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function samePersistenceStatus(left: PersistenceStatusRecord, right: PersistenceStatusRecord): boolean {
  return left.phase === right.phase
    && left.pendingSince === right.pendingSince
    && left.lastSavedAt === right.lastSavedAt
    && left.retryAttempt === right.retryAttempt
    && left.nextRetryAt === right.nextRetryAt
    && left.error === right.error;
}

function normalizeDelayMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return Math.max(0, Math.floor(fallback));
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Math.max(0, Math.floor(fallback));
}

function normalizeRetryDelayMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function persistenceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
