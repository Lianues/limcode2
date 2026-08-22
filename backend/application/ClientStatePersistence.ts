import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorldReader } from '../ecs/types';
import type { ConversationRunHistorySaveMode, ConversationTimelineSaveResult, StorageCapability } from '../capabilities/types';
import { StorageStateContributorsKey } from '../world/storageProjection/resources';
import { projectStorageStateWithCache, type StorageContributorProjectionState } from '../world/storageProjection/projection';
import {
  TERMINAL_TOOL_CALL_STATUSES,
  type AgentRunStatus,
  type ClientState,
  type ClientStateTableKey,
  type ConversationOriginLinkRecord,
  type ConversationTimelineMetaRecord,
  type ConversationTimelinePatchPayload,
  type MessageContent,
  type MessageRecord,
  type PersistenceStatusRecord,
  type SidebarConversationHistoryEntry,
  type ToolCallEventRecord,
  type ToolCallRecord
} from '../../shared/protocol';
import { conversationCreatedAtFromId, displayConversationTitle } from '../../shared/conversationTitle';
import { collectChangedClientStateConversationIds } from '../../shared/clientStateConversationScope';
import { createEmptyClientState } from '../../shared/clientStateSchema';
import { createPersistedConversationTimelineClientPatches } from './conversationTimelineClientPatch';
import { stripConversationFromClientState } from '../utils/clientStateConversationCascade';
import { conversationRenderDetailSlice, conversationRunHistorySlice } from '../capabilities/vscodeStorage/clientStateStore';
import { projectChatState } from '../world/modules/chat/stateProjection';
import { projectToolsRuntimeState } from '../world/modules/tools/stateProjection';
import { checkpointStateProjection } from '../world/modules/checkpoint/stateProjection';
import { projectStateProjection } from '../world/modules/project/stateProjection';
import { createClientStateSkeletonPatch, isClientStateSkeletonRevisionConflictError } from '../capabilities/vscodeStorage/clientStateSkeletonPatch';
import { skeletonStoresForProfile } from '../capabilities/vscodeStorage/clientStateSkeletonStores';
import { sharedConfigurationState, workspaceRuntimeState } from './sharedConfigurationState';
import {
  CONVERSATION_TIMELINE_TABLE_KEYS,
  isConversationTimelineRevisionConflictError,
  type ConversationTimelineRevisionConflictError,
  type ConversationTimelineTableKey
} from '../capabilities/vscodeStorage/conversationTimelinePatch';
import { createStorageRevision } from '../capabilities/vscodeStorage/storageRevision';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_PERSIST_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const MAX_TIMELINE_CONFLICT_RECOVERY_ATTEMPTS = 3;
const MUTATION_GATE_CONTEXT = 'client-state-persistence:mutation-gate';
const MISSING_SIDECAR_REBASE_TABLE_KEYS = new Set<ConversationTimelineTableKey>([
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks'
]);

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
  /** conversation timeline 成功提交后发布最新 chunk index 元数据。 */
  onConversationTimelineCommitted?: (metadata: ConversationTimelineMetaRecord) => void;
  /** 精确同步已提交的 page-owned record upsert/remove。 */
  onConversationTimelinePatched?: (payload: ConversationTimelinePatchPayload) => void;
  /** 测试可缩短；生产默认 250ms / 1s / 3s，耗尽后保留 error 状态等待下一次变更。 */
  retryDelaysMs?: readonly number[];
}

interface PendingRunHistoryState {
  readonly state: ClientState;
  readonly mode: ConversationRunHistorySaveMode;
}

export interface PersistedSkeletonSources {
  readonly workspaceState?: ClientState;
  readonly sharedConfigurationState?: ClientState;
}

interface CanonicalToolCallOverride {
  readonly rejectedLocalRevision: string;
  readonly canonicalRecord: ToolCallRecord;
  readonly canonicalEvents: readonly ToolCallEventRecord[];
}

/**
 * Storage 持久化使用独立投影缓存。懒加载后必须把骨架、聊天渲染详情与运行历史分开保存，
 * 避免普通聊天只加载 messages/toolCalls 时把未加载的 runHistory index 覆盖为空。
 */
export class ClientStatePersistence {
  private timelineEnabled = false;
  private skeletonEnabled = false;
  private lastPersistedSkeletonJson = '';
  /** 本进程上次确认提交的 workspace runtime skeleton base。 */
  private lastAcknowledgedLocalSkeletonState: ClientState | undefined;
  /** 本进程上次确认提交的跨工作区共享配置 skeleton base。 */
  private lastAcknowledgedSharedConfigurationState: ClientState | undefined;
  private pendingSkeletonState: ClientState | undefined;
  private readonly lastPersistedRenderDetailJson = new Map<string, string>();
  private readonly lastPublishedTimelineMetaSignature = new Map<string, string>();
  /** 每个 conversation 上次确认提交的本地 render base；外部 union 不写入该 base。 */
  private readonly lastAcknowledgedLocalRenderDetailState = new Map<string, ClientState>();
  /**
   * 多宿主竞争时被 canonical 终态拒绝的本地 ToolCall 快照。
   *
   * 在 ECS 仍投影出同一份被拒快照期间，后续强制保存继续使用 canonical 记录；否则刚完成
   * rebase 的下一次“重试前保存”会把 stale 终态再次覆盖回磁盘。记录删除或 revision 真正推进后
   * override 自动释放。
   */
  private readonly canonicalToolCallOverrides = new Map<string, Map<string, CanonicalToolCallOverride>>();
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

  public enable(options: { skeleton: boolean } = { skeleton: true }): void {
    this.timelineEnabled = true;
    this.skeletonEnabled = options.skeleton;
    this.emitStatus();
  }

  public statusSnapshot(): PersistenceStatusRecord {
    return { ...this.persistenceStatus };
  }

  private usesSharedConfigurationStorage(): boolean {
    return typeof this.storage.saveSharedConfigurationSkeleton === 'function';
  }

  private desiredSkeletonPersistenceJson(state: ClientState): string {
    const skeleton = skeletonPersistenceSlice(state);
    if (!this.usesSharedConfigurationStorage()) return JSON.stringify(skeleton);
    return splitSkeletonPersistenceJson(
      workspaceRuntimeState(skeleton),
      sharedConfigurationState(skeleton)
    );
  }

  public markSkeletonUnavailable(error: unknown): void {
    this.skeletonEnabled = false;
    void error;
    // timeline/render detail 的健康状态与 skeleton 独立；不能因 metadata hydration 失败
    // 让后续聊天消息静默不落盘。
  }

  public rememberPersistedState(state: ClientState, sources?: PersistedSkeletonSources): void {
    const skeleton = skeletonPersistenceSlice(state);
    if (this.usesSharedConfigurationStorage()) {
      const desiredWorkspace = workspaceRuntimeState(skeleton);
      const desiredSharedConfiguration = sharedConfigurationState(skeleton);
      const persistedWorkspace = sources
        ? skeletonPersistenceSlice(sources.workspaceState ?? createEmptyClientState())
        : desiredWorkspace;
      const persistedSharedConfiguration = sources
        ? sharedConfigurationState(skeletonPersistenceSlice(sources.sharedConfigurationState ?? createEmptyClientState()))
        : desiredSharedConfiguration;
      this.lastAcknowledgedLocalSkeletonState = cloneClientState(persistedWorkspace);
      this.lastAcknowledgedSharedConfigurationState = cloneClientState(persistedSharedConfiguration);
      this.lastPersistedSkeletonJson = splitSkeletonPersistenceJson(persistedWorkspace, persistedSharedConfiguration);
    } else {
      this.lastAcknowledgedLocalSkeletonState = cloneClientState(skeleton);
      this.lastAcknowledgedSharedConfigurationState = undefined;
      this.lastPersistedSkeletonJson = JSON.stringify(skeleton);
    }
    this.lastProjectedState = state;
    this.projectionClock = '';
    this.contributorStates = {};
    this.lastPersistedRenderDetailJson.clear();
    this.lastPublishedTimelineMetaSignature.clear();
    this.lastAcknowledgedLocalRenderDetailState.clear();
    this.canonicalToolCallOverrides.clear();
    this.lastPersistedRunHistoryJson.clear();
    this.markSaved();
  }

  /** staged hydration 的另一个 profile 仍属于同一组 pinned snapshot，分别合并进两个物理 base。 */
  public rememberPersistedSkeletonProfile(
    state: ClientState,
    profile: 'startup' | 'deferred',
    sources?: PersistedSkeletonSources
  ): void {
    if (this.usesSharedConfigurationStorage()) {
      const desired = skeletonPersistenceSlice(state);
      const workspaceProfile = sources
        ? skeletonPersistenceSlice(sources.workspaceState ?? createEmptyClientState())
        : workspaceRuntimeState(desired);
      const sharedConfigurationProfile = sources
        ? sharedConfigurationState(skeletonPersistenceSlice(sources.sharedConfigurationState ?? createEmptyClientState()))
        : sharedConfigurationState(desired);
      const workspaceBase = this.lastAcknowledgedLocalSkeletonState
        ? cloneClientState(this.lastAcknowledgedLocalSkeletonState)
        : createEmptyClientState();
      const sharedConfigurationBase = this.lastAcknowledgedSharedConfigurationState
        ? cloneClientState(this.lastAcknowledgedSharedConfigurationState)
        : createEmptyClientState();
      for (const store of skeletonStoresForProfile(profile)) {
        (workspaceBase as unknown as Record<string, unknown>)[store.key] = cloneSerializable(workspaceProfile[store.key]);
        (sharedConfigurationBase as unknown as Record<string, unknown>)[store.key] = cloneSerializable(sharedConfigurationProfile[store.key]);
      }
      this.lastAcknowledgedLocalSkeletonState = workspaceBase;
      this.lastAcknowledgedSharedConfigurationState = sharedConfigurationBase;
      this.lastPersistedSkeletonJson = splitSkeletonPersistenceJson(workspaceBase, sharedConfigurationBase);
      return;
    }

    const base = this.lastAcknowledgedLocalSkeletonState
      ? cloneClientState(this.lastAcknowledgedLocalSkeletonState)
      : createEmptyClientState();
    for (const store of skeletonStoresForProfile(profile)) {
      (base as unknown as Record<string, unknown>)[store.key] = cloneSerializable(state[store.key]);
    }
    this.lastAcknowledgedLocalSkeletonState = base;
    this.lastPersistedSkeletonJson = JSON.stringify(base);
  }

  /**
   * 记录刚从 storage 读取且未被本地修补的已知 render records。state 可以是完整 detail，
   * 也可以只是 tail page；partial base 只约束其中已知 id，不会把未加载 prefix 解释为删除。
   */
  public rememberConversationRenderDetailPersisted(conversationId: string, state: ClientState): void {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;
    const detail = conversationRenderDetailSlice(state, normalizedConversationId);
    this.canonicalToolCallOverrides.delete(normalizedConversationId);
    this.lastAcknowledgedLocalRenderDetailState.set(normalizedConversationId, cloneClientState(detail));
    this.lastPersistedRenderDetailJson.set(normalizedConversationId, JSON.stringify(detail));
  }

  /**
   * 把刚从当前 canonical timeline 读取并成功 hydrate 的局部 range 扩展进已确认 base。
   *
   * range 只补充此前未知的 record id，不能覆盖本进程已经确认的版本；否则较早的
   * range snapshot 可能把较新的本地 CAS base 倒退。调用方必须把“hydrate + 扩展”放在
   * exclusive mutation gate 内，避免持久化器观察到只 hydrate 了一半的区间。
   */
  public extendConversationRenderDetailPersistedRange(conversationId: string, state: ClientState): void {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;
    const range = conversationRenderDetailSlice(state, normalizedConversationId);
    const base = this.lastAcknowledgedLocalRenderDetailState.get(normalizedConversationId) ?? createEmptyClientState();
    const extended = extendAcknowledgedTimelineState(base, range);
    this.lastAcknowledgedLocalRenderDetailState.set(normalizedConversationId, extended);
    this.lastPersistedRenderDetailJson.set(normalizedConversationId, JSON.stringify(extended));
  }

  /**
   * 对两种可以由 canonical timeline 单义判定的陈旧 CAS base 做有界恢复：
   *
   * 1. 旧版本把未落盘 checkpoint sidecar 误记为已确认；
   * 2. 多 Extension Host 从同一非终态 ToolCall 出发，其中一个已先提交终态。
   *
   * 第二种情况必须让磁盘上的首个终态获胜，并连同该 ToolCall 的事件一起刷新本地
   * acknowledged base。否则另一个宿主会永久拿旧 executing revision 重试。除此之外的
   * 同 record 并发修改仍明确冲突，不降级为通用 last-writer-wins。
   */
  private async saveConversationTimelineWithConflictRecovery(
    conversationId: string,
    base: ClientState,
    next: ClientState,
    save: (rebasedBase: ClientState, localNext: ClientState) => Promise<ConversationTimelineSaveResult>
  ): Promise<ConversationTimelineSaveResult> {
    let candidateBase = base;
    let candidateNext = next;
    for (let attempt = 0; attempt < MAX_TIMELINE_CONFLICT_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        return await save(candidateBase, candidateNext);
      } catch (error) {
        if (!isConversationTimelineRevisionConflictError(error)) throw error;

        let stored: ClientState | undefined;
        try {
          stored = await this.storage.loadConversationDetail(conversationId);
        } catch (reloadError) {
          console.warn(`[LimCode] Failed to reload conversation timeline for CAS rebase: ${conversationId}`, reloadError);
          throw error;
        }
        const current = conversationRenderDetailSlice(stored ?? createEmptyClientState(), conversationId);

        if (isRecoverableMissingTimelineSidecarConflict(error, conversationId, candidateNext)) {
          if (timelineRecordExists(current, error.tableKey, error.recordId)) throw error;
          if (!requiredTimelineSidecarIds(candidateNext, current, error.tableKey).has(error.recordId)) throw error;
          const rebasedBase = rebaseMissingTimelineSidecars(candidateBase, candidateNext, current);
          if (!rebasedBase) throw error;
          candidateBase = rebasedBase;
          console.warn(`[LimCode] Rebasing missing conversation timeline sidecar records: ${conversationId}`);
          continue;
        }

        const rebasedToolCall = rebaseCanonicalTerminalToolCall(
          candidateBase,
          candidateNext,
          current,
          error
        );
        if (!rebasedToolCall) throw error;
        candidateBase = rebasedToolCall.base;
        candidateNext = rebasedToolCall.next;
        this.rememberCanonicalToolCallOverrides(conversationId, rebasedToolCall.overrides);
        console.warn(
          `[LimCode] Rebasing stale ToolCall to canonical terminal state: ${conversationId}/${error.recordId}`
        );
      }
    }
    throw new Error(`Conversation timeline CAS recovery exceeded its bounded retry limit: ${conversationId}`);
  }

  private rememberCanonicalToolCallOverrides(
    conversationId: string,
    overrides: ReadonlyMap<string, CanonicalToolCallOverride>
  ): void {
    if (overrides.size === 0) return;
    const known = this.canonicalToolCallOverrides.get(conversationId) ?? new Map<string, CanonicalToolCallOverride>();
    for (const [toolCallId, override] of overrides) known.set(toolCallId, override);
    this.canonicalToolCallOverrides.set(conversationId, known);
  }

  private applyCanonicalToolCallOverrides(conversationId: string, local: ClientState): ClientState {
    const overrides = this.canonicalToolCallOverrides.get(conversationId);
    if (!overrides || overrides.size === 0) return local;

    let effective = local;
    let cloned = false;
    for (const [toolCallId, override] of [...overrides]) {
      const localRecord = local.toolCalls.find((record) => record.id === toolCallId);
      if (!localRecord || createStorageRevision(localRecord) !== override.rejectedLocalRevision) {
        overrides.delete(toolCallId);
        continue;
      }
      if (!cloned) {
        effective = cloneClientState(local);
        cloned = true;
      }
      replaceToolCallAndEvents(effective, override.canonicalRecord, override.canonicalEvents);
    }
    if (overrides.size === 0) this.canonicalToolCallOverrides.delete(conversationId);
    return effective;
  }

  public queuePersist(options: { delayMs?: number } = {}): void {
    if (!this.timelineEnabled) return;
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

    if (!this.timelineEnabled || !latestState) {
      if (options.ensurePersisted || options.forceConversationId || options.throwOnError) {
        throw new Error('Client-state timeline persistence is not enabled.');
      }
      return;
    }

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
    const persistenceFailures: unknown[] = [];
    const failedRenderDetailStates: Array<[string, ClientState]> = [];
    const failedRunHistoryStates: Array<[string, PendingRunHistoryState]> = [];
    let failedSkeletonState: ClientState | undefined;
    let failedHistoryStates: Array<[string, ClientState]> = [];
    // 先启动 render detail 保存，让每个 conversation 立即预订自己的 timeline root FIFO。
    // 后续消息 truncate 会排在这些旧快照之后，而不会被 skeleton/run-history 慢任务拖到旧快照前面。
    const renderDetailTask = awaitAllPersistTasks(renderDetailStates.map(async ([conversationId, state]) => {
      try {
        const next = this.applyCanonicalToolCallOverrides(
          conversationId,
          conversationRenderDetailSlice(state, conversationId)
        );
        const base = this.lastAcknowledgedLocalRenderDetailState.get(conversationId) ?? createEmptyClientState();
        const committed = await this.saveConversationTimelineWithConflictRecovery(
          conversationId,
          base,
          next,
          (rebasedBase, localNext) => this.storage.saveConversationRenderDetail(conversationId, rebasedBase, localNext)
        );
        const acknowledged = committed.state;
        this.lastAcknowledgedLocalRenderDetailState.set(conversationId, cloneClientState(acknowledged));
        // dedupe 比较的是本地投影；canonical ACK 可能补回 page 未加载的 compression sidecar。
        this.lastPersistedRenderDetailJson.set(conversationId, JSON.stringify(next));
        await this.publishConversationTimelineCommit(conversationId, base, acknowledged, committed);
      } catch (error) {
        failedRenderDetailStates.push([conversationId, state]);
        throw error;
      }
    }));
    const nextSkeleton = skeletonState ? skeletonPersistenceSlice(skeletonState) : undefined;
    const usesSharedConfigurationStorage = this.usesSharedConfigurationStorage();
    const nextLocalSkeleton = nextSkeleton
      ? usesSharedConfigurationStorage ? workspaceRuntimeState(nextSkeleton) : nextSkeleton
      : undefined;
    const nextSharedConfiguration = nextSkeleton && usesSharedConfigurationStorage
      ? sharedConfigurationState(nextSkeleton)
      : undefined;
    const skeletonPatch = nextLocalSkeleton
      ? createClientStateSkeletonPatch(this.lastAcknowledgedLocalSkeletonState ?? createEmptyClientState(), nextLocalSkeleton)
      : undefined;
    const sharedConfigurationPatch = nextSharedConfiguration
      ? createClientStateSkeletonPatch(this.lastAcknowledgedSharedConfigurationState ?? createEmptyClientState(), nextSharedConfiguration)
      : undefined;
    const skeletonTask = nextLocalSkeleton && skeletonPatch
      ? Promise.all([
          this.storage.saveClientStateSkeleton(skeletonPatch).then(() => undefined),
          nextSharedConfiguration && sharedConfigurationPatch
            ? this.storage.saveSharedConfigurationSkeleton!(sharedConfigurationPatch).then(() => undefined)
            : Promise.resolve()
        ]).then(() => {
          this.lastAcknowledgedLocalSkeletonState = cloneClientState(nextLocalSkeleton);
          this.lastAcknowledgedSharedConfigurationState = nextSharedConfiguration
            ? cloneClientState(nextSharedConfiguration)
            : undefined;
          this.lastPersistedSkeletonJson = nextSharedConfiguration
            ? splitSkeletonPersistenceJson(nextLocalSkeleton, nextSharedConfiguration)
            : JSON.stringify(nextLocalSkeleton);
        })
      : Promise.resolve();
    try {
      // render 与 skeleton 并行；render 已先创建，因此会先预订 conversation timeline 队列。
      const [renderResult, skeletonResult] = await Promise.allSettled([renderDetailTask, skeletonTask]);
      if (renderResult.status === 'rejected') persistenceFailures.push(renderResult.reason);
      if (skeletonResult.status === 'rejected') {
        failedSkeletonState = skeletonState;
        persistenceFailures.push(skeletonResult.reason);
      }

      // skeleton 是全局目录；conversation timeline 已按独立目录落盘，不能让一个 skeleton 冲突把整个窗口
      // 所有对话的 render detail 重新放回 pending。只有 render detail 本身成功后，才继续保存其 run/history 衍生数据。
      if (renderResult.status === 'fulfilled') {
        await awaitAllPersistTasks(runHistoryStates.map(async ([conversationId, pending]) => {
          try {
            await this.storage.saveConversationRunHistory(conversationId, pending.state, { mode: pending.mode });
            this.lastPersistedRunHistoryJson.set(conversationId, JSON.stringify(conversationRunHistorySlice(pending.state, conversationId)));
          } catch (error) {
            failedRunHistoryStates.push([conversationId, pending]);
            throw error;
          }
        })).catch((error) => {
          persistenceFailures.push(error);
        });

        await this.persistHistoryEntries(historyStates).catch((error) => {
          failedHistoryStates = historyStates;
          persistenceFailures.push(error);
        });
      } else {
        failedRunHistoryStates.push(...runHistoryStates);
        failedHistoryStates = historyStates;
      }

      if (persistenceFailures.length > 0) throw primaryPersistenceFailure(persistenceFailures);
      persistSucceeded = true;
      this.retryAttempt = 0;
    } catch (error) {
      persistenceFailure = error;
      shouldRetry = !options.throwOnError && shouldRetryPersistenceFailures(persistenceFailures.length > 0 ? persistenceFailures : [error]);
      this.restorePendingStates(failedSkeletonState, failedRenderDetailStates, failedRunHistoryStates, failedHistoryStates);
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
    if (!normalizedConversationId) return;
    if (!this.timelineEnabled) {
      if (options.throwOnError) throw new Error('Conversation timeline persistence is not enabled.');
      return;
    }

    if (this.mutationGateActive && !this.isInsideMutationGate()) {
      this.persistPendingAfterMutationGate = true;
      await this.waitForMutationGateIdle();
      return this.persistConversationRenderDetailImmediately(normalizedConversationId, options);
    }

    const state = this.applyCanonicalToolCallOverrides(
      normalizedConversationId,
      this.options.projectConversationTimelineState?.(this.world, normalizedConversationId)
        ?? projectConversationTimelineState(this.world, normalizedConversationId)
    );

    try {
      const base = this.lastAcknowledgedLocalRenderDetailState.get(normalizedConversationId) ?? createEmptyClientState();
      const committed = await this.saveConversationTimelineWithConflictRecovery(
        normalizedConversationId,
        base,
        state,
        (rebasedBase, localNext) => this.storage.saveConversationTimelineRenderDetail(
          normalizedConversationId,
          rebasedBase,
          localNext
        )
      );
      const acknowledged = mergeAcknowledgedTimelineState(base, committed.state);
      this.lastAcknowledgedLocalRenderDetailState.set(normalizedConversationId, acknowledged);
      this.lastPersistedRenderDetailJson.set(normalizedConversationId, JSON.stringify(state));
      await this.publishConversationTimelineCommit(normalizedConversationId, base, acknowledged, committed);
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
    if (!normalizedConversationId || !this.timelineEnabled) return action();
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

  public discardConversation(conversationId: string, additionalRunIds: Iterable<string> = []): void {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;

    this.pendingRenderDetailStates.delete(normalizedConversationId);
    this.pendingRunHistoryStates.delete(normalizedConversationId);
    this.pendingHistoryStates.delete(normalizedConversationId);
    this.lastPersistedRenderDetailJson.delete(normalizedConversationId);
    this.lastPublishedTimelineMetaSignature.delete(normalizedConversationId);
    this.lastAcknowledgedLocalRenderDetailState.delete(normalizedConversationId);
    this.canonicalToolCallOverrides.delete(normalizedConversationId);
    this.lastPersistedRunHistoryJson.delete(normalizedConversationId);

    const stripOptions = { additionalRunIds };
    if (this.pendingSkeletonState) {
      this.pendingSkeletonState = stripConversationFromClientState(this.pendingSkeletonState, normalizedConversationId, stripOptions);
    }
    if (this.lastProjectedState) {
      this.lastProjectedState = stripConversationFromClientState(this.lastProjectedState, normalizedConversationId, stripOptions);
    }
    // 调用契约：仅在 coordinator 语义删除已 committed 后调用，届时才能推进本地 base。
    if (this.lastAcknowledgedLocalSkeletonState) {
      this.lastAcknowledgedLocalSkeletonState = stripConversationFromClientState(
        this.lastAcknowledgedLocalSkeletonState,
        normalizedConversationId,
        stripOptions
      );
      this.lastPersistedSkeletonJson = this.usesSharedConfigurationStorage()
        ? splitSkeletonPersistenceJson(
            this.lastAcknowledgedLocalSkeletonState,
            this.lastAcknowledgedSharedConfigurationState ?? createEmptyClientState()
          )
        : JSON.stringify(this.lastAcknowledgedLocalSkeletonState);
    }
  }

  private async publishConversationTimelineCommit(
    conversationId: string,
    previous: ClientState,
    acknowledged: ClientState,
    commit: Pick<ConversationTimelineSaveResult, 'commitSeq' | 'committedAt'>
  ): Promise<void> {
    if (!this.options.onConversationTimelineCommitted && !this.options.onConversationTimelinePatched) return;
    const patches = createPersistedConversationTimelineClientPatches(previous, acknowledged);
    if (patches.length > 0 && this.options.onConversationTimelinePatched) {
      try {
        this.options.onConversationTimelinePatched({
          conversationId,
          commitSeq: commit.commitSeq,
          committedAt: commit.committedAt,
          patches
        });
      } catch (error) {
        console.warn(`[LimCode] Failed to publish conversation timeline patch: ${conversationId}`, error);
      }
    }

    if (!this.options.onConversationTimelineCommitted) return;
    try {
      const metadata = await this.storage.loadConversationTimelineMeta(conversationId);
      const signature = timelineMetaStructuralSignature(metadata);
      if (this.lastPublishedTimelineMetaSignature.get(conversationId) === signature) return;
      this.lastPublishedTimelineMetaSignature.set(conversationId, signature);
      this.options.onConversationTimelineCommitted(metadata);
    } catch (error) {
      // timeline 正文已经成功提交，meta 通知失败不能反向把持久化标记为失败。
      console.warn(`[LimCode] Failed to publish conversation timeline metadata: ${conversationId}`, error);
    }
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
    if (this.skeletonEnabled) {
      const skeletonJson = this.desiredSkeletonPersistenceJson(state);
      if (force || skeletonJson !== this.lastPersistedSkeletonJson) {
        this.pendingSkeletonState = state;
      }
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

function timelineMetaStructuralSignature(metadata: ConversationTimelineMetaRecord): string {
  const oldest = metadata.oldestChunk;
  const newest = metadata.newestChunk;
  return [
    metadata.totalChunks,
    metadata.totalMessages,
    oldest?.id ?? '',
    oldest?.startSeq ?? '',
    oldest?.endSeq ?? '',
    oldest?.messageCount ?? '',
    newest?.id ?? '',
    newest?.startSeq ?? '',
    newest?.endSeq ?? '',
    newest?.messageCount ?? ''
  ].join(':');
}

async function awaitAllPersistTasks(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function primaryPersistenceFailure(failures: readonly unknown[]): unknown {
  return failures.find((error) => !isClientStateSkeletonRevisionConflictError(error)) ?? failures[0];
}

function shouldRetryPersistenceFailures(failures: readonly unknown[]): boolean {
  return failures.some((error) => !isClientStateSkeletonRevisionConflictError(error) && !isConversationTimelineRevisionConflictError(error));
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

function splitSkeletonPersistenceJson(workspaceState: ClientState, sharedConfiguration: ClientState): string {
  return JSON.stringify({ workspaceState, sharedConfiguration });
}

function skeletonPersistenceSlice(state: ClientState): ClientState {
  return {
    ...state,
    workEnvironments: state.workEnvironments.map(normalizeWorkEnvironmentForSkeletonPersistence),
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

function mergeAcknowledgedTimelineState(base: ClientState, nextTimeline: ClientState): ClientState {
  const merged = cloneClientState(base);
  for (const key of CONVERSATION_TIMELINE_TABLE_KEYS) {
    (merged as unknown as Record<string, unknown>)[key] = cloneSerializable(nextTimeline[key]);
  }
  return merged;
}

function extendAcknowledgedTimelineState(base: ClientState, persistedRange: ClientState): ClientState {
  const extended = cloneClientState(base);
  for (const key of CONVERSATION_TIMELINE_TABLE_KEYS) {
    const knownRecords = timelineRecords(extended, key);
    const knownIds = new Set(knownRecords.map((record) => record.id));
    const additions = timelineRecords(persistedRange, key)
      .filter((record) => !knownIds.has(record.id))
      .map((record) => cloneSerializable(record));
    if (additions.length > 0) assignTimelineRecords(extended, key, [...knownRecords, ...additions]);
  }
  return extended;
}

function isRecoverableMissingTimelineSidecarConflict(
  error: unknown,
  conversationId: string,
  next: ClientState
): boolean {
  return isConversationTimelineRevisionConflictError(error)
    && error.conversationId === conversationId
    && error.expectedRevision !== null
    && error.actualRevision === null
    && MISSING_SIDECAR_REBASE_TABLE_KEYS.has(error.tableKey)
    && timelineRecordExists(next, error.tableKey, error.recordId);
}

function rebaseMissingTimelineSidecars(
  base: ClientState,
  next: ClientState,
  current: ClientState
): ClientState | undefined {
  const rebased = cloneClientState(base);
  let changed = false;
  for (const key of MISSING_SIDECAR_REBASE_TABLE_KEYS) {
    const requiredIds = requiredTimelineSidecarIds(next, current, key);
    const currentIds = new Set(timelineRecords(current, key).map((record) => record.id));
    const baseRecords = timelineRecords(rebased, key);
    const retained = baseRecords.filter((record) => !requiredIds.has(record.id) || currentIds.has(record.id));
    if (retained.length === baseRecords.length) continue;
    assignTimelineRecords(rebased, key, retained);
    changed = true;
  }
  return changed ? rebased : undefined;
}

/**
 * 同一非终态 ToolCall 被多个宿主加载后，只接受第一个成功写入 canonical timeline 的终态。
 * 后到宿主必须同时放弃自己的 ToolCall 状态和关联事件，避免出现 record=error、event=success
 * 之类的半合并结果。只有 identity 完全相同且 error 中的两侧 revision 都能由重读结果证明时
 * 才允许 rebase；终态之间基于终态 CAS 的真实并发修改仍继续报错。
 */
function rebaseCanonicalTerminalToolCall(
  base: ClientState,
  next: ClientState,
  current: ClientState,
  error: ConversationTimelineRevisionConflictError
): { base: ClientState; next: ClientState; overrides: ReadonlyMap<string, CanonicalToolCallOverride> } | undefined {
  if (error.tableKey !== 'toolCalls' || error.expectedRevision === null || error.actualRevision === null) return undefined;

  const triggeringBase = base.toolCalls.find((record) => record.id === error.recordId);
  const triggeringNext = next.toolCalls.find((record) => record.id === error.recordId);
  const triggeringCurrent = current.toolCalls.find((record) => record.id === error.recordId);
  if (!triggeringBase || !triggeringNext || !triggeringCurrent) return undefined;
  if (createStorageRevision(triggeringBase) !== error.expectedRevision
    || createStorageRevision(triggeringCurrent) !== error.actualRevision
    || TERMINAL_TOOL_CALL_STATUSES.has(triggeringBase.status)
    || !TERMINAL_TOOL_CALL_STATUSES.has(triggeringCurrent.status)
    || !sameToolCallIdentity(triggeringBase, triggeringNext)
    || !sameToolCallIdentity(triggeringBase, triggeringCurrent)) {
    return undefined;
  }

  const rebasedBase = cloneClientState(base);
  const rebasedNext = cloneClientState(next);
  const currentById = new Map(current.toolCalls.map((record) => [record.id, record]));
  const overrides = new Map<string, CanonicalToolCallOverride>();
  let triggerRebased = false;

  for (const baseRecord of base.toolCalls) {
    const nextRecord = next.toolCalls.find((record) => record.id === baseRecord.id);
    const currentRecord = currentById.get(baseRecord.id);
    if (!nextRecord || !currentRecord) continue;
    if (createStorageRevision(baseRecord) === createStorageRevision(nextRecord)) continue;
    if (TERMINAL_TOOL_CALL_STATUSES.has(baseRecord.status)
      || !TERMINAL_TOOL_CALL_STATUSES.has(currentRecord.status)
      || !sameToolCallIdentity(baseRecord, nextRecord)
      || !sameToolCallIdentity(baseRecord, currentRecord)) {
      continue;
    }

    replaceToolCallAndEvents(rebasedBase, currentRecord, current.toolCallEvents);
    replaceToolCallAndEvents(rebasedNext, currentRecord, current.toolCallEvents);
    overrides.set(baseRecord.id, {
      rejectedLocalRevision: createStorageRevision(nextRecord),
      canonicalRecord: cloneSerializable(currentRecord),
      canonicalEvents: current.toolCallEvents
        .filter((event) => event.toolCallId === baseRecord.id)
        .map((event) => cloneSerializable(event))
    });
    if (baseRecord.id === error.recordId) triggerRebased = true;
  }

  return triggerRebased ? { base: rebasedBase, next: rebasedNext, overrides } : undefined;
}

function sameToolCallIdentity(left: ToolCallRecord, right: ToolCallRecord): boolean {
  return left.id === right.id
    && left.messageId === right.messageId
    && left.name === right.name
    && (left.functionCallId ?? '') === (right.functionCallId ?? '')
    && left.args === right.args
    && left.createdAt === right.createdAt;
}

function replaceToolCallAndEvents(
  state: ClientState,
  canonical: ToolCallRecord,
  currentEvents: readonly ToolCallEventRecord[]
): void {
  state.toolCalls = state.toolCalls.map((record) => (
    record.id === canonical.id ? cloneSerializable(canonical) : record
  ));
  state.toolCallEvents = [
    ...state.toolCallEvents.filter((event) => event.toolCallId !== canonical.id),
    ...currentEvents
      .filter((event) => event.toolCallId === canonical.id)
      .map((event) => cloneSerializable(event))
  ].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

function requiredTimelineSidecarIds(
  next: ClientState,
  current: ClientState,
  key: ConversationTimelineTableKey
): ReadonlySet<string> {
  if (key === 'shadowRepositories') {
    return new Set(current.checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
  }
  if (key === 'projectContexts') {
    return new Set(current.checkpoints.map((checkpoint) => checkpoint.projectContextId));
  }
  if (key === 'conversationCheckpointRepositoryLinks') {
    const shadowRepositoryIds = new Set(current.checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
    const projectContextIds = new Set(current.checkpoints.map((checkpoint) => checkpoint.projectContextId));
    return new Set(next.conversationCheckpointRepositoryLinks
      .filter((link) => shadowRepositoryIds.has(link.shadowRepositoryId) || projectContextIds.has(link.projectContextId))
      .map((link) => link.id));
  }
  return new Set();
}

function timelineRecordExists(state: ClientState, key: ConversationTimelineTableKey, recordId: string): boolean {
  return timelineRecords(state, key).some((record) => record.id === recordId);
}

function timelineRecords(state: ClientState, key: ConversationTimelineTableKey): Array<{ id: string }> {
  return state[key] as Array<{ id: string }>;
}

function assignTimelineRecords(state: ClientState, key: ConversationTimelineTableKey, records: Array<{ id: string }>): void {
  (state as unknown as Record<ConversationTimelineTableKey, Array<{ id: string }>>)[key] = records;
}

function normalizeWorkEnvironmentForSkeletonPersistence<T extends { kind?: string; source?: string; available?: boolean; index?: number }>(record: T): T {
  if (record.kind !== 'localFolder' || (record.source !== undefined && record.source !== 'workspaceFolder')) return cloneSerializable(record);
  const clone = cloneSerializable(record) as Record<string, unknown>;
  clone.available = true;
  delete clone.index;
  return clone as T;
}

function cloneClientState(state: ClientState): ClientState {
  return cloneSerializable(state);
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
