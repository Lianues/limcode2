import * as vscode from 'vscode';
import { MapWorld } from '../ecs/World';
import { Scheduler } from '../ecs/Scheduler';
import type { ComponentType, Entity } from '../ecs/types';
import { ClientSyncEventType } from '../world/clientSync/events';
import { EffectOutbox, type WorldEffect } from '../world/effects';
import { installWorldPlugins } from '../world/plugin';
import {
  agentPlugin,
  chatPlugin,
  commonPlugin,
  workflowPlugin,
  planReviewPlugin,
  agentRunPlugin,
  agentAnswerPlugin,
  checkpointPlugin,
  compressionPlugin,
  llmPlugin,
  requestSpawnAgent,
  projectPlugin,
  runtimeContextPlugin,
  toolsPlugin,
  backgroundCommandPlugin,
  skillPlugin,
  rulesPlugin,
  workEnvironmentPlugin
} from '../world/modules';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import { Agent, AgentConversationLink, AgentKind, AgentStatus as AgentStatusComponent, ConversationAgentSelection } from '../world/modules/agent/components';
import {
  Conversation,
  ConversationBranchLink,
  ConversationFullContextLoaded,
  ConversationFullContextPending,
  ConversationOriginLink,
  ConversationReuseLink,
  LlmRequest,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf
} from '../world/modules/chat/components';
import type { MessageData } from '../world/modules/chat/components';
import { ChatEventType } from '../world/modules/chat/events';
import { OpenConversationPanelIdsKey } from '../world/modules/chat/resources';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunWorkflowLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../world/modules/agentRun/components';
import { AgentRunEventType } from '../world/modules/agentRun/events';
import { setConversationProject } from '../world/modules/project/bundles';
import { ConversationProjectLink, ProjectContext } from '../world/modules/project/components';
import { upsertDefaultWorkflowSelection } from '../world/modules/workflow/bundles';
import { ConversationWorkflowSelection, ModelProfile, ModelProfileScopeLink, type ModelProfileScopeLinkData } from '../world/modules/workflow/components';
import { ToolCall, ToolCallEvent } from '../world/modules/tools/components';
import { WorkEnvironmentEventType, workEnvironmentIdFromUri } from '../world/modules/workEnvironment';
import type { LocalWorkEnvironmentCandidate } from '../world/modules/workEnvironment';
import { clientSyncPlugin, registerClientSyncSystems } from '../world/clientSync';
import { ClientSyncStateKey } from '../world/clientSync/resources';
import { storageProjectionPlugin } from '../world/storageProjection';
import { CLIENT_STATE_TABLE_KEYS } from '../../shared/clientStateSchema';
import { EffectHandlerRegistry, registerApplicationEffectHandlers } from './effectHandlers';
import { flushEffects, flushEffectsWhere } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import { BridgeMessageType, GLOBAL_SETTINGS_SECTIONS, conversationClientStateStreamId, createMessageId } from '../../shared/protocol';
import type {
  AgentRunStatus,
  CheckpointMaintenanceSettingsRecord,
  BridgeClientId,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ClientState,
  ConversationLlmSettingsRecord,
  ConversationSettingsRecord,
  LlmProviderKind,
  MessageContent,
  ProjectFolderCandidateRecord,
  ConversationOriginLinkRecord,
  RuleScope,
  SidebarHistoryScopeKind,
  SidebarConversationHistoryEntry,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../shared/protocol';
import { createRuntimeEnv, recordsForTools, schemasForTools } from './createRuntimeEnv';
import { dedupeMcpToolNames } from './mcpRuntimeManager';
import { createDefaultAgentRecord, createDefaultAgentSpawnRequest, DEFAULT_AGENT_ID } from './defaults';
import { hydrateClientStateSkeleton, hydrateConversationDetail } from './clientStateHydration';
import { backfillMissingToolResponsesForStatelessLoad } from './toolResponseBackfill';
import { ClientStatePersistence } from './ClientStatePersistence';
import { GlobalSettingsBridge } from './GlobalSettingsBridge';
import { ConversationSettingsBridge } from './ConversationSettingsBridge';
import { WebviewClientRegistry } from './WebviewClientRegistry';
import { WebviewMessageRouter } from './WebviewMessageRouter';
import { conversationCreatedAtFromId, createNewConversationTitle, DEFAULT_CONVERSATION_ID, displayConversationTitle } from '../../shared/conversationTitle';
import { loadRemoteServerWorkEnvironmentRecordsFromVscode } from './workEnvironments/vscodeSshImport';
import { McpToolSourcesKey, ToolDefinitionsKey, ToolRuntimeDefinitionsKey, ToolSchemasKey } from '../world/modules/tools/resources';
import { SkillCatalogKey } from '../world/modules/skill/resources';
import { RulesCatalogKey } from '../world/modules/rules/resources';
import { conversationDetailEvictionBlocker, evictConversationDetail } from './conversationDetailEviction';
import { forkConversationInWorld } from './conversationFork';
import { AskUserAttentionTracker, askUserAttentionMessage, collectPendingAskUserAttention } from './askUserAttention';
import { ConversationAttentionTracker, type ConversationAttentionRequest } from './conversationAttention';
import { PlanReviewAttentionTracker, collectPendingPlanReviewAttention, planReviewAttentionMessage } from './planReviewAttention';

const MAX_WARM_CLOSED_CONVERSATIONS = 3;
const USER_ATTENTION_NOTIFICATION_ACTION = '打开标签页';
const OPEN_PANEL_COMMAND = 'limcode.openPanel';

export interface CreateConversationOptions {
  projectFolderUri?: string;
}

export interface SetConversationProjectFolderInput {
  conversationId: string;
  folderUri: string;
  name?: string;
}

/**
 * 后端应用组合根（composition root）。
 * 只负责组装 ECS world、runtime capability、effect handlers 与 VS Code/Webview 对外门面。
 */
export class BackendApplication {
  private readonly world = new MapWorld();
  private readonly outbox = new EffectOutbox();
  private readonly env: RuntimeEnv;
  private readonly scheduler: Scheduler;
  private readonly effectHandlers = new EffectHandlerRegistry();
  private readonly persistence: ClientStatePersistence;
  private readonly globalSettingsBridge: GlobalSettingsBridge;
  private readonly conversationSettingsBridge: ConversationSettingsBridge;
  private readonly webviewClients = new WebviewClientRegistry();
  private readonly webviewRouter: WebviewMessageRouter;
  private readonly askUserAttentionTracker = new AskUserAttentionTracker();
  private readonly planReviewAttentionTracker = new PlanReviewAttentionTracker();
  private hydrated = false;
  private resolveHydrated: () => void = () => undefined;
  private readonly hydratedReady = new Promise<void>((resolve) => { this.resolveHydrated = resolve; });
  private deferredSkeletonReady: Promise<void> = Promise.resolve();
  private disposePromise: Promise<void> | undefined;
  private disposing = false;
  private pendingGlobalSnapshot = false;
  private readonly pendingSnapshotConversationIds = new Set<string>();
  private readonly pendingHydrationMessages: Array<{ clientId: BridgeClientId; message: WebviewToExtensionMessage }> = [];
  private readonly pendingDeferredSkeletonMessages: Array<{ clientId: BridgeClientId; message: WebviewToExtensionMessage }> = [];
  private deferredSkeletonComplete = false;
  private readonly renderLoadedConversationDetails = new Set<string>();
  private readonly runHistoryLoadedConversationDetails = new Set<string>();
  private readonly conversationTailLoaded = new Set<string>();
  private readonly conversationTailLoadInFlight = new Map<string, Promise<void>>();
  private readonly conversationDetailLoadInFlight = new Map<string, Promise<void>>();
  private readonly conversationContextLoadInFlight = new Set<string>();
  /** 从旧到新排列；仅记录最后一个主面板已经关闭的 conversation。 */
  private readonly recentClosedConversationIds: string[] = [];
  /** 冷卸载后仅保留历史列表摘要，避免重命名等轻量更新把预览误写为空。 */
  private readonly coldConversationHistoryEntries = new Map<string, SidebarConversationHistoryEntry>();
  private readonly conversationEvictionGeneration = new Map<string, number>();
  private conversationEvictionInFlight: string | undefined;
  private readonly conversationHistoryChangedEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  public readonly onDidChangeConversationHistory = this.conversationHistoryChangedEmitter.event;

  public constructor(context: vscode.ExtensionContext) {
    const { env, toolSchemas, toolDefinitions } = createRuntimeEnv(context);
    this.env = env;
    this.world.setResource(OpenConversationPanelIdsKey, []);
    this.env.mcp.setStateChangeListener(() => this.syncMcpRuntimeResources());
    this.persistence = new ClientStatePersistence(this.world, this.env.storage, {
      renderLoadedConversationIds: () => this.persistableRenderDetailConversationIds(),
      runHistoryLoadedConversationIds: () => this.runHistoryLoadedConversationDetails,
      isConversationHistorySummaryComplete: (conversationId) => this.isConversationHistorySummaryComplete(conversationId)
    });
    this.globalSettingsBridge = new GlobalSettingsBridge({
      storage: this.env.storage,
      webview: this.env.webview,
      beforeDataRootChange: () => this.persistence.persistImmediately({ force: true, throwOnError: true }),
      beforeUpdate: (payload) => this.beforeGlobalSettingsUpdate(payload),
      afterUpdate: (payload) => this.afterGlobalSettingsUpdate(payload)
    });
    this.conversationSettingsBridge = new ConversationSettingsBridge({
      world: this.world,
      storage: this.env.storage,
      webview: this.env.webview,
      requestSnapshot: (conversationId) => this.requestSnapshot(conversationId),
      afterRead: (stored) => this.afterConversationSettingsRead(stored),
      afterUpdate: (stored) => this.afterConversationSettingsUpdate(stored)
    });
    this.webviewRouter = new WebviewMessageRouter({
      world: this.world,
      webview: this.env.webview,
      clients: this.webviewClients,
      storage: this.env.storage,
      fs: this.env.fs,
      llm: this.env.llm,
      command: this.env.command,
      globalSettingsBridge: this.globalSettingsBridge,
      conversationSettingsBridge: this.conversationSettingsBridge,
      isHydrated: () => this.hydrated,
      requestSnapshot: (conversationId) => this.requestSnapshot(conversationId),
      requestPersist: (reason) => this.requestPersistSoon(reason),
      flushPersistence: (_reason) => this.persistence.persistImmediately({ ensurePersisted: true, throwOnError: true }),
      ensureConversationDetailLoaded: (conversationId) => this.ensureConversationDetailLoaded(conversationId),
      ensureConversationTailLoaded: (conversationId) => this.ensureConversationTailLoaded(conversationId),
      getProjectFolderCandidates: () => this.getProjectFolderCandidates(),
      setConversationProjectFolder: (input) => this.setConversationProjectFolder(input),
      importWorkEnvironmentsFromVscode: () => this.importWorkEnvironmentsFromVscode(),
      refreshSkillCatalog: () => this.syncSkillCatalogResource(),
      refreshRulesCatalog: () => this.syncRulesCatalogResource(),
      saveRuleFile: (scope, content) => this.saveRuleFile(scope, content)
    });

    registerApplicationEffectHandlers(this.effectHandlers);
    this.registerConversationContextEffectHandler();
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.syncWorkEnvironmentsFromWorkspaceFolders();
      void this.syncSkillCatalogResource();
      void this.syncRulesCatalogResource();
    }));

    this.scheduler = new Scheduler(this.world, {
      applyEffect: (effect) => this.outbox.push(effect as WorldEffect),
      afterPass: () => {
        flushEffectsWhere(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers, isPassFlushEffect);
      },
      afterTick: () => {
        flushEffects(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers);
        this.notifyPendingUserAttention();
        this.persistence.queuePersist();
        this.conversationHistoryChangedEmitter.fire();
        this.processConversationDetailEvictions();
      }
    }, {
      parallelWorkers: true,
      workerPoolSize: 2
    });

    installWorldPlugins(
      { world: this.world, scheduler: this.scheduler },
      [commonPlugin(), clientSyncPlugin(), storageProjectionPlugin(), agentPlugin(), workflowPlugin(), planReviewPlugin(), projectPlugin(), workEnvironmentPlugin(), runtimeContextPlugin(), checkpointPlugin(), compressionPlugin(), llmPlugin(), agentAnswerPlugin(), toolsPlugin({ toolSchemas, toolDefinitions, toolRuntimeDefinitions: this.env.tools.registry }), backgroundCommandPlugin(), skillPlugin(), rulesPlugin(), chatPlugin(), agentRunPlugin()]
    );
    registerClientSyncSystems(this.scheduler);

    void this.initializeClientState();
  }

  /** 由外部显式请求生成 agent；基础对话会在初始化时创建 main/default。 */
  public requestAgentSpawn(request: AgentSpawnRequestData): void {
    requestSpawnAgent(this.world, request);
  }

  /** 创建一个独立 conversation，并用独立 AgentConversationLink 绑定到默认 agent。 */
  public async createConversation(options: CreateConversationOptions = {}): Promise<string> {
    const conversationId = `conversation-${createMessageId()}`;
    const title = createNewConversationTitle();
    const agent = this.findDefaultAgent();
    if (agent === undefined) {
      requestSpawnAgent(this.world, { ...createDefaultAgentSpawnRequest(), conversationId, conversationTitle: title, initialMessage: undefined });
      this.requestSnapshot(conversationId);
      return conversationId;
    }

    const conversation = this.world.spawn();
    this.world.add(conversation, Conversation, { id: conversationId, title, visibility: 'visible' });
    this.world.add(conversation, ConversationFullContextLoaded, { loadedAt: Date.now() });

    const now = Date.now();
    const origin = this.world.spawn();
    this.world.add(origin, ConversationOriginLink, {
      id: `col${origin}`,
      conversation,
      originKind: 'user',
      sourceKind: 'user',
      createdAt: now,
      updatedAt: now
    });

    const link = this.world.spawn();
    this.world.add(link, AgentConversationLink, {
      id: `acl${link}`,
      agent,
      conversation,
      role: 'default',
      createdAt: now,
      updatedAt: now
    });

    const selection = this.world.spawn();
    const agentRecord = this.world.get(agent, Agent);
    this.world.add(selection, ConversationAgentSelection, {
      id: `conversation-agent:${conversationId}:${agentRecord?.id ?? DEFAULT_AGENT_ID}`,
      conversation,
      agent,
      role: 'active',
      createdAt: now,
      updatedAt: now
    });

    upsertDefaultWorkflowSelection(this.world, conversation, conversationId);

    const projectFolder = this.resolveProjectFolderForNewConversation(options.projectFolderUri);
    if (projectFolder) setConversationProject(this.world, { conversation, uri: projectFolder.uri, name: projectFolder.name });

    this.renderLoadedConversationDetails.add(conversationId);
    this.runHistoryLoadedConversationDetails.add(conversationId);
    this.conversationTailLoaded.add(conversationId);
    this.requestSnapshot();
    void this.upsertConversationHistoryEntry(conversationId)
      .catch((error) => console.warn('[LimCode] Failed to persist new conversation history entry.', error));
    return conversationId;
  }

  /** 从源对话开头复制到指定消息（含）并创建一条独立的 fork conversation。 */
  public async forkConversation(sourceConversationId: string, messageId: string): Promise<string> {
    const normalizedSourceId = sourceConversationId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSourceId || !normalizedMessageId) throw new Error('缺少源对话或目标消息。');

    await this.waitUntilHydrated();
    await this.ensureConversationDetailLoaded(normalizedSourceId);

    const conversationId = `conversation-${createMessageId()}`;
    forkConversationInWorld(this.world, {
      sourceConversationId: normalizedSourceId,
      throughMessageId: normalizedMessageId,
      targetConversationId: conversationId
    });

    this.renderLoadedConversationDetails.add(conversationId);
    this.runHistoryLoadedConversationDetails.add(conversationId);
    this.conversationTailLoaded.add(conversationId);
    await this.copyConversationSettings(normalizedSourceId, conversationId);

    this.requestSnapshot();
    this.requestSnapshot(conversationId);
    await this.persistence.persistImmediately({ forceConversationId: conversationId });
    return conversationId;
  }

  /** 侧边栏只读投影：按最近消息时间排序的对话历史列表。 */
  public getConversationHistoryEntries(): SidebarConversationHistoryEntry[] {
    const messagesByConversation = this.collectMessagesByConversation();
    const agentNamesByConversation = this.collectAgentNamesByConversation();
    const runSummariesByConversation = this.collectRunSummariesByConversation();
    const projectsByConversation = this.collectProjectsByConversation();
    const entries: SidebarConversationHistoryEntry[] = [];

    for (const entity of this.world.query(Conversation)) {
      const conversation = this.world.get(entity, Conversation);
      if (!conversation?.id) continue;
      const messages = messagesByConversation.get(entity) ?? [];
      const latest = latestMessage(messages);
      const agentName = agentNamesByConversation.get(entity);
      const runSummary = runSummariesByConversation.get(entity);
      const project = projectsByConversation.get(entity);
      const preview = latest ? messagePreview(latest) : '暂无消息，点击开始新的交流。';
      const entry: SidebarConversationHistoryEntry = {
        id: conversation.id,
        title: displayConversationTitle({ id: conversation.id, title: conversation.title, messages }),
        preview,
        messageCount: messages.length,
        status: latest?.status ?? 'empty',
        isRunning: !!runSummary
      };
      const previewState = latest ? aiPreviewState(latest) : undefined;
      if (previewState) entry.previewState = previewState;
      const fallbackUpdatedAt = conversationCreatedAtFromId(conversation.id);
      if (latest) entry.updatedAt = latest.createdAt; else if (fallbackUpdatedAt !== undefined) entry.updatedAt = fallbackUpdatedAt;
      if (agentName) entry.agentName = agentName;
      if (project) {
        entry.projectFolderUri = project.uri;
        entry.projectName = project.name;
      }
      if (runSummary) {
        entry.runStatus = runSummary.status;
        entry.runStatusLabel = runSummary.label;
        entry.updatedAt = Math.max(entry.updatedAt ?? 0, runSummary.updatedAt);
      }
      entries.push(entry);
    }

    return entries.filter((entry) => entry.title).sort(compareConversationHistoryEntries);
  }

  public getConversationDisplayTitle(conversationId: string | undefined): string {
    if (!conversationId) return 'LimCode';
    const entity = this.findConversationEntity(conversationId);
    if (entity === undefined) return displayConversationTitle({ id: conversationId });
    const conversation = this.world.get(entity, Conversation);
    if (!conversation) return displayConversationTitle({ id: conversationId });

    const messages = this.collectMessagesByConversation().get(entity) ?? [];
    return displayConversationTitle({ id: conversation.id, title: conversation.title, messages });
  }

  public ensureConversationPlaceholder(conversationId: string, title?: string): boolean {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return false;
    const existing = this.findConversationEntity(normalizedConversationId);
    if (existing !== undefined) {
      const current = this.world.get(existing, Conversation);
      const nextTitle = title?.trim() ? normalizeConversationTitle(title) : undefined;
      if (current && nextTitle && !current.title) {
        this.world.add(existing, Conversation, { ...current, title: nextTitle });
        this.requestSnapshot();
        this.requestSnapshot(normalizedConversationId);
        this.persistence.queuePersist();
        return true;
      }
      return false;
    }

    const now = Date.now();
    const conversation = this.world.spawn();
    this.world.add(conversation, Conversation, {
      id: normalizedConversationId,
      title: normalizeConversationTitle(title ?? ''),
      visibility: 'visible'
    });

    const origin = this.world.spawn();
    this.world.add(origin, ConversationOriginLink, {
      id: `col${origin}`,
      conversation,
      originKind: 'user',
      sourceKind: 'user',
      createdAt: now,
      updatedAt: now
    });

    const agent = this.findDefaultAgent() ?? this.ensurePreHydrationAgent(DEFAULT_AGENT_ID);
    this.ensurePreHydrationAgentConversationLink(conversation, normalizedConversationId, agent, now);

    const agentRecord = this.world.get(agent, Agent);
    const selection = this.world.spawn();
    this.world.add(selection, ConversationAgentSelection, {
      id: `conversation-agent:${normalizedConversationId}:${agentRecord?.id ?? DEFAULT_AGENT_ID}`,
      conversation,
      agent,
      role: 'active',
      createdAt: now,
      updatedAt: now
    });

    upsertDefaultWorkflowSelection(this.world, conversation, normalizedConversationId);
    void this.upsertConversationHistoryEntry(normalizedConversationId);
    this.requestSnapshot();
    this.requestSnapshot(normalizedConversationId);
    this.persistence.queuePersist();
    return true;
  }

  public renameConversationTitle(conversationId: string, title: string): boolean {
    const entity = this.findConversationEntity(conversationId);
    if (entity === undefined) return false;
    const conversation = this.world.get(entity, Conversation);
    if (!conversation) return false;

    this.world.add(entity, Conversation, { ...conversation, title: normalizeConversationTitle(title) });
    void this.upsertConversationHistoryEntry(conversationId);
    this.requestSnapshot();
    this.requestSnapshot(conversationId);
    return true;
  }

  public deleteConversation(conversationId: string): boolean {
    const entity = this.findConversationEntity(conversationId);
    if (entity === undefined) return false;

    const cascade = this.collectConversationCascadeEntities(entity, conversationId);
    for (const target of cascade) {
      const request = this.world.get(target, LlmRequest);
      if (request?.id) this.env.llm.abort(request.id);
    }
    for (const target of cascade) {
      this.world.despawn(target);
    }
    this.renderLoadedConversationDetails.delete(conversationId);
    this.runHistoryLoadedConversationDetails.delete(conversationId);
    this.conversationTailLoaded.delete(conversationId);
    this.coldConversationHistoryEntries.delete(conversationId);
    this.removeRecentClosedConversation(conversationId);
    this.bumpConversationEvictionGeneration(conversationId);
    void this.env.storage.removeConversationHistoryEntry(conversationId);
    this.requestSnapshot();
    this.requestSnapshot(conversationId);
    return true;
  }

  public abortConversation(conversationId: string): boolean {
    const entity = this.findConversationEntity(conversationId);
    if (entity === undefined) return false;

    this.world.enqueue({ type: AgentRunEventType.CancelConversation, payload: { conversationId, reason: 'sidebar_abort' } });
    this.requestSnapshot();
    this.requestSnapshot(conversationId);
    return true;
  }

  public getProjectFolderCandidates(): ProjectFolderCandidateRecord[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      index
    }));
  }

  public setConversationProjectFolder(input: SetConversationProjectFolderInput): boolean {
    const conversation = this.findConversationEntity(input.conversationId);
    if (conversation === undefined) return false;

    const candidate = this.projectFolderCandidateForUri(input.folderUri);
    const uri = candidate?.uri ?? input.folderUri.trim();
    if (!uri) return false;

    setConversationProject(this.world, {
      conversation,
      uri,
      name: input.name ?? candidate?.name ?? projectFolderNameFromUri(uri)
    });
    void this.upsertConversationHistoryEntry(input.conversationId);
    this.requestSnapshot();
    this.requestSnapshot(input.conversationId);
    return true;
  }

  /** 当前 active data root；可能是 VS Code 默认 globalStorageUri，也可能是用户配置的自定义目录。 */
  public getStorageRootUri(): vscode.Uri {
    return this.env.storage.paths.globalStorageUri;
  }

  public getConversationHistoryRootUri(): vscode.Uri {
    return this.env.storage.paths.conversationHistoryRootUri;
  }

  public attachWebview(webview: vscode.Webview, meta: WebviewClientMeta = { kind: 'unknown' }): BridgeClientId {
    const clientId = this.env.webview.attach(webview, meta);
    this.webviewClients.register(clientId, meta);
    const conversationId = mainPanelConversationId(meta);
    if (conversationId) {
      this.markConversationOpened(conversationId);
      this.syncOpenConversationPanelPresence(conversationId);
    }
    return clientId;
  }

  public ensureConversationTailLoaded(conversationId: string): Promise<void> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || this.isConversationTailLoaded(normalizedConversationId)) return Promise.resolve();

    const existing = this.conversationTailLoadInFlight.get(normalizedConversationId);
    if (existing) return existing;

    const load = this.loadConversationTail(normalizedConversationId);
    this.conversationTailLoadInFlight.set(normalizedConversationId, load);
    const clear = (): void => {
      if (this.conversationTailLoadInFlight.get(normalizedConversationId) === load) {
        this.conversationTailLoadInFlight.delete(normalizedConversationId);
        this.processConversationDetailEvictions();
      }
    };
    void load.then(clear, clear);
    return load;
  }

  private isConversationTailLoaded(conversationId: string): boolean {
    if (this.conversationTailLoaded.has(conversationId)) return true;
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) return false;
    const loaded = this.world.has(conversation, ConversationFullContextLoaded)
      || this.world.query(Message, PartOf).some((entity) => this.world.get(entity, PartOf)?.parent === conversation);
    if (loaded) this.conversationTailLoaded.add(conversationId);
    return loaded;
  }

  private async loadConversationTail(conversationId: string): Promise<void> {
    const page = await this.env.storage.loadConversationTimelinePage({
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    if (page.state.messages.length > 0 && this.findConversationEntity(conversationId) === undefined) {
      this.spawnPreHydrationConversation(conversationId);
    }
    if (page.state.messages.length > 0) {
      const backfilled = backfillMissingToolResponsesForStatelessLoad(page.state, conversationId);
      await hydrateConversationDetail(this.world, backfilled.state, conversationId);
      if (backfilled.addedCount > 0) {
        this.requestSnapshot(conversationId);
        this.persistence.queuePersist();
      }
    }
    this.conversationTailLoaded.add(conversationId);
  }

  public ensureConversationDetailLoaded(conversationId: string): Promise<void> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return Promise.resolve();
    if (this.renderLoadedConversationDetails.has(normalizedConversationId)) {
      this.markConversationFullContextLoaded(normalizedConversationId);
      return Promise.resolve();
    }

    const existing = this.conversationDetailLoadInFlight.get(normalizedConversationId);
    if (existing) return existing;

    const load = this.loadConversationDetail(normalizedConversationId);
    this.conversationDetailLoadInFlight.set(normalizedConversationId, load);
    const clear = (): void => {
      if (this.conversationDetailLoadInFlight.get(normalizedConversationId) === load) {
        this.conversationDetailLoadInFlight.delete(normalizedConversationId);
        this.processConversationDetailEvictions();
      }
    };
    void load.then(clear, clear);
    return load;
  }

  private async loadConversationDetail(conversationId: string): Promise<void> {
    if (!this.hydrated) await this.waitUntilHydrated();
    if (this.renderLoadedConversationDetails.has(conversationId)) {
      this.markConversationFullContextLoaded(conversationId);
      return;
    }

    const storedDetail = await this.env.storage.loadConversationDetail(conversationId, { includeRunHistory: false });
    // 历史 timeline 可能因为截断/重试/增量持久化交错留下“ToolCall 终态存在，但
    // Message.content 中缺少 functionResponse”的不一致记录。无论是冷加载还是无状态
    // 加载，都先用已保存的 toolCalls 结果补齐消息层响应，避免后续压缩/模型上下文被
    // 半截 functionCall 卡住。
    const backfilled = storedDetail
      ? backfillMissingToolResponsesForStatelessLoad(storedDetail, conversationId)
      : { state: storedDetail, addedCount: 0 };
    const detail = backfilled.state;

    if (detail && this.findConversationEntity(conversationId) === undefined) {
      this.spawnPreHydrationConversation(conversationId);
    }

    const hydrated = detail ? await hydrateConversationDetail(this.world, detail, conversationId) : false;
    if (detail && hydrated) this.primeConversationStreamState(conversationId, detail);
    const loaded = hydrated || this.findConversationEntity(conversationId) !== undefined;
    if (loaded) {
      this.renderLoadedConversationDetails.add(conversationId);
      this.coldConversationHistoryEntries.delete(conversationId);
      this.markConversationFullContextLoaded(conversationId);
    }
    if (hydrated && backfilled.addedCount > 0) {
      this.requestSnapshot(conversationId);
      this.persistence.queuePersist();
    }
  }

  public getCurrentProjectHistoryScope(): ConversationHistoryScope {
    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeEditorUri ? vscode.workspace.getWorkspaceFolder(activeEditorUri) : undefined;
    if (activeFolder) return { kind: 'project', folderUri: activeFolder.uri.toString() };

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 0) return { kind: 'project', folderUri: folders[0].uri.toString() };
    return { kind: 'unbound' };
  }

  public async getConversationHistoryPage(input: { scopeKind: SidebarHistoryScopeKind; projectFolderUri?: string; cursor?: string; limit?: number }): Promise<ConversationHistoryPageRecord> {
    const scope = this.resolveHistoryScope(input.scopeKind, input.projectFolderUri);
    const page = await this.env.storage.loadConversationHistoryPage({ scope, cursor: input.cursor, limit: input.limit });
    return this.mergeLiveConversationHistoryPage(page, scope);
  }

  private resolveHistoryScope(scopeKind: SidebarHistoryScopeKind, projectFolderUri: string | undefined): ConversationHistoryScope {
    if (scopeKind === 'all') return { kind: 'all' };
    if (scopeKind === 'unbound') return { kind: 'unbound' };
    if (scopeKind === 'project' && projectFolderUri?.trim()) return { kind: 'project', folderUri: projectFolderUri.trim() };
    return this.getCurrentProjectHistoryScope();
  }

  private mergeLiveConversationHistoryPage(page: ConversationHistoryPageRecord, scope: ConversationHistoryScope): ConversationHistoryPageRecord {
    const entriesById = new Map(page.entries.map((entry) => [entry.id, entry]));
    const liveEntries = this.getConversationHistoryEntries()
      .filter((entry) => this.isConversationHistorySummaryComplete(entry.id) && (historyEntryMatchesScope(entry, scope) || entriesById.has(entry.id)));
    if (liveEntries.length === 0) return page;

    const isFirstPage = page.pageInfo.pageIndex === 0;
    let changed = false;
    for (const entry of liveEntries) {
      if (!isFirstPage && !entriesById.has(entry.id)) continue;
      const existing = entriesById.get(entry.id);
      const scopedEntry = existing && !historyEntryMatchesScope(entry, scope)
        ? { ...entry, projectFolderUri: existing.projectFolderUri, projectName: existing.projectName }
        : entry;
      if (existing && JSON.stringify(existing) === JSON.stringify(scopedEntry)) continue;
      entriesById.set(entry.id, scopedEntry);
      changed = true;
    }
    if (!changed) return page;

    const nominalPageSize = Math.max(page.pageInfo.pageSize || 0, page.entries.length || 0, 1);
    const entries = [...entriesById.values()].sort(compareConversationHistoryEntries);
    const visibleEntries = isFirstPage ? entries.slice(0, nominalPageSize) : entries;
    const visibleEntryIds = new Set(visibleEntries.map((entry) => entry.id));
    const originLinksByConversationId = new Map(page.originLinks.map((link) => [link.conversationId, link]));
    for (const [conversationId, originLink] of this.collectConversationOriginLinksById()) {
      if (visibleEntryIds.has(conversationId)) originLinksByConversationId.set(conversationId, originLink);
    }

    return {
      ...page,
      entries: visibleEntries,
      originLinks: [...originLinksByConversationId.values()].filter((link) => visibleEntryIds.has(link.conversationId)),
      pageInfo: {
        ...page.pageInfo,
        total: Math.max(page.pageInfo.total, visibleEntries.length)
      }
    };
  }

  private persistableRenderDetailConversationIds(): string[] {
    const ids = new Set(this.renderLoadedConversationDetails);
    for (const conversationId of this.conversationTailLoaded) ids.add(conversationId);
    return [...ids].filter((conversationId) => this.findConversationEntity(conversationId) !== undefined);
  }

  private isConversationHistorySummaryComplete(conversationId: string): boolean {
    return this.renderLoadedConversationDetails.has(conversationId);
  }

  private collectConversationOriginLinksById(): Map<string, ConversationOriginLinkRecord> {
    const result = new Map<string, ConversationOriginLinkRecord>();
    for (const [entity, originLink] of this.collectConversationOriginsByConversation()) {
      const conversation = this.world.get(entity, Conversation);
      if (conversation?.id) result.set(conversation.id, originLink);
    }
    return result;
  }


  private async upsertConversationHistoryEntry(conversationId: string): Promise<void> {
    const projected = this.getConversationHistoryEntries().find((candidate) => candidate.id === conversationId);
    if (!projected) return;
    const retained = this.coldConversationHistoryEntries.get(conversationId);
    const entry = retained && !this.isConversationHistorySummaryComplete(conversationId)
      ? {
          ...retained,
          ...projected,
          preview: retained.preview,
          messageCount: retained.messageCount,
          status: retained.status,
          updatedAt: Math.max(retained.updatedAt ?? 0, projected.updatedAt ?? 0),
          ...(retained.previewState ? { previewState: retained.previewState } : {})
        }
      : projected;
    const conversationEntity = this.findConversationEntity(conversationId);
    const originLink = conversationEntity === undefined
      ? undefined
      : this.collectConversationOriginsByConversation().get(conversationEntity);
    await this.env.storage.upsertConversationHistoryEntry(entry, originLink);
  }


  public waitUntilHydrated(): Promise<void> {
    return this.hydrated ? Promise.resolve() : this.hydratedReady;
  }

  private registerConversationContextEffectHandler(): void {
    this.effectHandlers.register('conversation.context.load', (effect) => {
      this.scheduleConversationContextLoad(effect.conversationId);
    });
  }

  private scheduleConversationContextLoad(conversationId: string): void {
    if (!conversationId || this.conversationContextLoadInFlight.has(conversationId)) return;
    this.conversationContextLoadInFlight.add(conversationId);
    setTimeout(() => {
      void this.ensureConversationDetailLoaded(conversationId)
        .catch((error) => {
          console.warn('[LimCode] Failed to hydrate conversation context for LLM.', error);
        })
        .finally(() => {
          this.conversationContextLoadInFlight.delete(conversationId);
          this.clearConversationFullContextPending(conversationId);
          this.requestSnapshot(conversationId);
        });
    }, 0);
  }

  private markConversationFullContextLoaded(conversationId: string): void {
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) return;
    this.conversationTailLoaded.add(conversationId);
    this.world.add(conversation, ConversationFullContextLoaded, { loadedAt: Date.now() });
    this.world.remove(conversation, ConversationFullContextPending);
  }

  private clearConversationFullContextPending(conversationId: string): void {
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) return;
    this.world.remove(conversation, ConversationFullContextPending);
  }

  public detachWebview(clientId: BridgeClientId): void {
    const registration = this.webviewClients.get(clientId);
    const releasedStreamIds = this.env.webview.detach(clientId);
    this.webviewClients.unregister(clientId);
    if (releasedStreamIds.length > 0) {
      this.world.enqueue({
        type: ClientSyncEventType.StreamsReleased,
        payload: { streamIds: releasedStreamIds }
      });
    }

    const conversationId = registration ? mainPanelConversationId(registration.meta) : undefined;
    if (conversationId) {
      this.syncOpenConversationPanelPresence(conversationId);
      if (!this.hasOpenConversationPanel(conversationId)) this.rememberRecentlyClosedConversation(conversationId);
      void this.persistence.persistImmediately({ forceConversationId: conversationId })
        .catch((error) => console.warn(`[LimCode] Failed to persist conversation "${conversationId}" after panel detach.`, error));
    }
  }

  private notifyPendingUserAttention(): void {
    this.notifyPendingConversationAttention(
      this.askUserAttentionTracker,
      collectPendingAskUserAttention(this.world),
      askUserAttentionMessage
    );
    this.notifyPendingConversationAttention(
      this.planReviewAttentionTracker,
      collectPendingPlanReviewAttention(this.world),
      planReviewAttentionMessage
    );
  }

  private notifyPendingConversationAttention<TRequest extends ConversationAttentionRequest & { conversationTitle?: string }>(
    tracker: ConversationAttentionTracker<TRequest>,
    requests: readonly TRequest[],
    createMessage: (request: TRequest) => string
  ): void {
    for (const request of tracker.takeNew(requests)) {
      void vscode.window.showInformationMessage(
        createMessage(request),
        USER_ATTENTION_NOTIFICATION_ACTION
      ).then((selection) => {
        if (selection !== USER_ATTENTION_NOTIFICATION_ACTION) return undefined;
        return vscode.commands.executeCommand(OPEN_PANEL_COMMAND, {
          conversationId: request.conversationId,
          ...(request.conversationTitle ? { title: request.conversationTitle } : {}),
          reuse: true
        });
      }).then(undefined, (error) => {
        console.warn('[LimCode] Failed to open the conversation awaiting user input.', error);
      });
    }
  }

  private syncOpenConversationPanelPresence(changedConversationId: string): void {
    const conversationIds = [...new Set(
      this.env.webview.clientRecords()
        .map((client) => mainPanelConversationId(client.meta))
        .filter((conversationId): conversationId is string => !!conversationId)
    )].sort();
    this.world.setResource(OpenConversationPanelIdsKey, conversationIds);
    this.world.enqueue({
      type: ChatEventType.ConversationPanelPresenceChanged,
      payload: { conversationId: changedConversationId, open: conversationIds.includes(changedConversationId) }
    });
  }

  private markConversationOpened(conversationId: string): void {
    this.removeRecentClosedConversation(conversationId);
    this.bumpConversationEvictionGeneration(conversationId);
  }

  private rememberRecentlyClosedConversation(conversationId: string): void {
    if (this.findConversationEntity(conversationId) === undefined) return;
    this.removeRecentClosedConversation(conversationId);
    this.recentClosedConversationIds.push(conversationId);
    this.bumpConversationEvictionGeneration(conversationId);
    this.processConversationDetailEvictions();
  }

  private removeRecentClosedConversation(conversationId: string): void {
    const index = this.recentClosedConversationIds.indexOf(conversationId);
    if (index >= 0) this.recentClosedConversationIds.splice(index, 1);
  }

  private bumpConversationEvictionGeneration(conversationId: string): number {
    const next = (this.conversationEvictionGeneration.get(conversationId) ?? 0) + 1;
    this.conversationEvictionGeneration.set(conversationId, next);
    return next;
  }

  private hasOpenConversationPanel(conversationId: string): boolean {
    return this.env.webview.clientRecords().some((client) => mainPanelConversationId(client.meta) === conversationId);
  }

  private processConversationDetailEvictions(): void {
    if (this.conversationEvictionInFlight || this.recentClosedConversationIds.length <= MAX_WARM_CLOSED_CONVERSATIONS) return;

    const overflowCount = this.recentClosedConversationIds.length - MAX_WARM_CLOSED_CONVERSATIONS;
    for (const conversationId of this.recentClosedConversationIds.slice(0, overflowCount)) {
      if (this.hasOpenConversationPanel(conversationId)) {
        this.removeRecentClosedConversation(conversationId);
        this.processConversationDetailEvictions();
        return;
      }
      if (this.conversationTailLoadInFlight.has(conversationId)
        || this.conversationDetailLoadInFlight.has(conversationId)
        || this.conversationContextLoadInFlight.has(conversationId)) continue;

      const conversation = this.findConversationEntity(conversationId);
      if (conversation === undefined) {
        this.removeRecentClosedConversation(conversationId);
        this.processConversationDetailEvictions();
        return;
      }
      if (conversationDetailEvictionBlocker(this.world, conversation)) continue;

      const generation = this.conversationEvictionGeneration.get(conversationId) ?? 0;
      this.conversationEvictionInFlight = conversationId;
      void this.persistAndEvictConversationDetail(conversationId, generation);
      return;
    }
  }

  private async persistAndEvictConversationDetail(conversationId: string, generation: number): Promise<void> {
    let continueDraining = true;
    try {
      await this.persistence.persistImmediately({ forceConversationId: conversationId, throwOnError: true });
      if ((this.conversationEvictionGeneration.get(conversationId) ?? 0) !== generation) return;
      if (this.hasOpenConversationPanel(conversationId)) return;
      if (this.conversationTailLoadInFlight.has(conversationId)
        || this.conversationDetailLoadInFlight.has(conversationId)
        || this.conversationContextLoadInFlight.has(conversationId)) return;

      const warmStart = Math.max(0, this.recentClosedConversationIds.length - MAX_WARM_CLOSED_CONVERSATIONS);
      const queueIndex = this.recentClosedConversationIds.indexOf(conversationId);
      if (queueIndex < 0 || queueIndex >= warmStart) return;

      const conversation = this.findConversationEntity(conversationId);
      if (conversation === undefined || conversationDetailEvictionBlocker(this.world, conversation)) return;

      const historyEntry = this.getConversationHistoryEntries().find((candidate) => candidate.id === conversationId);
      if (historyEntry) this.coldConversationHistoryEntries.set(conversationId, historyEntry);
      const result = evictConversationDetail(this.world, conversation);
      this.renderLoadedConversationDetails.delete(conversationId);
      this.runHistoryLoadedConversationDetails.delete(conversationId);
      this.conversationTailLoaded.delete(conversationId);
      this.world.remove(conversation, ConversationFullContextLoaded);
      this.world.remove(conversation, ConversationFullContextPending);
      this.removeRecentClosedConversation(conversationId);
      this.requestSnapshot();
      console.debug(`[LimCode] Cold-evicted conversation detail "${conversationId}" (${result.removedEntities} entities).`);
    } catch (error) {
      continueDraining = false;
      console.warn(`[LimCode] Failed to persist conversation "${conversationId}" before cold eviction.`, error);
    } finally {
      if (this.conversationEvictionInFlight === conversationId) this.conversationEvictionInFlight = undefined;
      if (continueDraining) this.processConversationDetailEvictions();
    }
  }

  public handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    if (this.disposing) return;
    if (!this.hydrated && this.handlePreHydrationChatSend(clientId, message)) return;
    if (!this.hydrated && shouldDeferUntilHydrated(message)) {
      this.pendingHydrationMessages.push({ clientId, message });
      return;
    }
    if (this.hydrated && !this.deferredSkeletonComplete && shouldDeferUntilDeferredSkeleton(message)) {
      this.pendingDeferredSkeletonMessages.push({ clientId, message });
      return;
    }
    this.webviewRouter.handle(clientId, message);
  }

  private handlePreHydrationChatSend(clientId: BridgeClientId, message: WebviewToExtensionMessage): boolean {
    if (message.type !== BridgeMessageType.ChatSend || !message.payload) return false;
    this.ensurePreHydrationChatTarget(message.payload.conversationId, message.payload.agentId);
    this.webviewRouter.handle(clientId, message);
    return true;
  }

  private ensurePreHydrationChatTarget(conversationId: string, agentId: string | undefined): void {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;
    const now = Date.now();

    const conversation = this.findConversationEntity(normalizedConversationId) ?? this.spawnPreHydrationConversation(normalizedConversationId);
    const existingSelection = this.activeSelectionForConversation(conversation);
    const selectedAgent = agentId?.trim()
      ? this.ensurePreHydrationAgent(agentId.trim())
      : existingSelection?.agent ?? this.findDefaultAgent() ?? this.ensurePreHydrationAgent(DEFAULT_AGENT_ID);

    this.ensurePreHydrationAgentConversationLink(conversation, normalizedConversationId, selectedAgent, now);
    if (existingSelection) {
      const current = this.world.get(existingSelection.entity, ConversationAgentSelection);
      if (current && current.agent !== selectedAgent) {
        this.world.add(existingSelection.entity, ConversationAgentSelection, { ...current, agent: selectedAgent, updatedAt: now });
      }
    } else {
      const agent = this.world.get(selectedAgent, Agent);
      const selection = this.world.spawn();
      this.world.add(selection, ConversationAgentSelection, {
        id: `conversation-agent:${normalizedConversationId}:${agent?.id ?? DEFAULT_AGENT_ID}`,
        conversation,
        agent: selectedAgent,
        role: 'active',
        createdAt: now,
        updatedAt: now
      });
    }
  }

  private spawnPreHydrationConversation(conversationId: string): Entity {
    const conversation = this.world.spawn();
    this.world.add(conversation, Conversation, { id: conversationId, visibility: 'visible' });
    upsertDefaultWorkflowSelection(this.world, conversation, conversationId);
    return conversation;
  }

  private ensurePreHydrationAgent(agentId: string): Entity {
    const existing = this.findAgentEntity(agentId);
    if (existing !== undefined) return existing;

    const defaultAgent = createDefaultAgentRecord();
    const isDefault = agentId === DEFAULT_AGENT_ID;
    const agent = this.world.spawn();
    this.world.add(agent, Agent, {
      id: agentId,
      name: isDefault ? defaultAgent.name : agentId,
      source: isDefault ? defaultAgent.source : 'user'
    });
    this.world.add(agent, AgentKind, { kind: isDefault ? defaultAgent.kind : agentId });
    this.world.add(agent, AgentStatusComponent, { status: 'idle' });
    return agent;
  }

  private ensurePreHydrationAgentConversationLink(conversation: Entity, conversationId: string, agent: Entity, now: number): void {
    const agentRecord = this.world.get(agent, Agent);
    const exists = this.world.query(AgentConversationLink).some((entity) => {
      const link = this.world.get(entity, AgentConversationLink);
      return link?.conversation === conversation && link.agent === agent;
    });
    if (exists) return;

    const link = this.world.spawn();
    this.world.add(link, AgentConversationLink, {
      id: `acl:early:${conversationId}:${agentRecord?.id ?? DEFAULT_AGENT_ID}`,
      conversation,
      agent,
      role: 'default',
      createdAt: now,
      updatedAt: now
    });
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.disposing = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.env.webview.detachAll();
    this.webviewClients.clear();
    this.env.mcp.setStateChangeListener(undefined);
    this.env.command.dispose();

    await this.hydratedReady;
    await this.deferredSkeletonReady;
    await this.scheduler.stopAndDrain();

    let persistenceError: unknown;
    try {
      await this.persistForShutdown();
    } catch (error) {
      persistenceError = error;
    }

    await this.env.mcp.dispose();
    if (persistenceError) throw persistenceError;
  }

  private async persistForShutdown(): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.persistence.persistImmediately({ ensurePersisted: true, throwOnError: true });
        return;
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  private async initializeClientState(): Promise<void> {
    let startupStorageHealthy = true;
    try {
      await this.env.storage.ensureReady();
      const restored = await this.env.storage.loadClientStateSkeleton({ profile: 'startup' });
      const hasPreHydrationMessages = this.world.query(Message).length > 0;
      if (restored && await hydrateClientStateSkeleton(this.world, restored, { resetMessageSeq: !hasPreHydrationMessages })) {
        this.persistence.rememberPersistedState(restored);
      } else if (this.world.query(Agent).length > 0 || this.world.query(Conversation).length > 0) {
        // Early chat.send may have created the minimal ECS target before startup skeleton finished.
      } else {
        requestSpawnAgent(this.world, createDefaultAgentSpawnRequest());
      }
    } catch (error) {
      startupStorageHealthy = false;
      console.warn('[LimCode] Failed to initialize stored chat state. Starting with a fresh in-memory conversation; skeleton persistence remains disabled to protect existing data.', error);
      requestSpawnAgent(this.world, createDefaultAgentSpawnRequest());
    } finally {
      this.hydrated = true;
      this.deferredSkeletonComplete = false;
      // 工作环境、存档点等策略属于 deferred skeleton。先启动 deferred hydration，再放行配置类消息，
      // 避免设置页刚打开时的修改被尚未加载的旧 skeleton 覆盖或因 scope 依赖未就绪而丢弃。
      this.deferredSkeletonReady = this.startDeferredClientStateSkeletonLoad(startupStorageHealthy);
      this.flushPendingSnapshots();
      this.flushPendingHydrationMessages();
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        void this.globalSettingsBridge.postSnapshot(undefined, section);
      }
      this.startCheckpointShadowAutoCleanup();
      void this.refreshMcpRuntime(true);
      void this.syncSkillCatalogResource();
      void this.syncRulesCatalogResource();
      this.resolveHydrated();
    }
  }

  private async startDeferredClientStateSkeletonLoad(startupStorageHealthy: boolean): Promise<void> {
    let deferredStorageHealthy = true;
    try {
      const deferred = await this.env.storage.loadClientStateSkeleton({ profile: 'deferred' });
      if (deferred) {
        const hydrated = await hydrateClientStateSkeleton(this.world, deferred, { allowDefaults: false, resetMessageSeq: false });
        if (hydrated) {
          this.requestSnapshot();
          this.conversationHistoryChangedEmitter.fire();
        }
      }
    } catch (error) {
      deferredStorageHealthy = false;
      console.warn('[LimCode] Failed to lazy-load deferred client state skeleton.', error);
    } finally {
      try {
        this.syncWorkEnvironmentsFromWorkspaceFolders();
      } catch (error) {
        deferredStorageHealthy = false;
        console.warn('[LimCode] Failed to synchronize workspace work environments after deferred hydration.', error);
      }
      if (startupStorageHealthy && deferredStorageHealthy) {
        this.persistence.enable();
        this.persistence.queuePersist();
      } else {
        console.warn('[LimCode] Skeleton persistence is disabled for this session to avoid overwriting partially loaded data.');
      }
      this.deferredSkeletonComplete = true;
      this.flushPendingDeferredSkeletonMessages();
    }
  }

  private startCheckpointShadowAutoCleanup(): void {
    void (async () => {
      try {
        const loaded = await this.env.storage.loadGlobalSettings('checkpointMaintenance');
        const settings = loaded.settings as CheckpointMaintenanceSettingsRecord;
        if (!settings.autoCleanupEnabled) return;
        const result = await this.env.storage.cleanupUnusedShadowWorktrees(settings.autoCleanupDays);
        if (result.deletedStorageKeys.length > 0) {
          console.info(`[LimCode] Auto-cleaned ${result.deletedStorageKeys.length} unused shadow worktrees (>${settings.autoCleanupDays}d).`);
        }
      } catch (error) {
        console.warn('[LimCode] Failed to auto-clean unused shadow worktrees.', error);
      }
    })();
  }

  private requestPersistSoon(reason: string): void {
    setTimeout(() => {
      void this.persistence.persistImmediately({ force: true }).catch((error) => {
        console.warn(`[LimCode] Failed to persist after config mutation (${reason}).`, error);
      });
    }, 750);
  }

  private requestSnapshot(conversationId?: string): void {
    if (this.disposing) return;
    if (!this.hydrated) {
      if (conversationId) this.pendingSnapshotConversationIds.add(conversationId);
      else this.pendingGlobalSnapshot = true;
      return;
    }
    this.world.enqueue({ type: ClientSyncEventType.Resync, payload: conversationId ? { conversationId } : {} });
  }

  private async beforeGlobalSettingsUpdate(payload: { section: string; settings?: unknown }): Promise<void> {
    if (payload.section === 'llm') {
      await this.freezeLoadedConversationsToCurrentGlobalLlmDefault();
      return;
    }
    if (payload.section === 'llmProviderConfigs') {
      await this.freezeLoadedConversationsToCurrentProviderModels();
    }
  }

  private async copyConversationSettings(sourceConversationId: string, targetConversationId: string): Promise<void> {
    try {
      const common = await this.env.storage.loadConversationSettings(sourceConversationId, 'common');
      const settings = common?.settings as ConversationSettingsRecord | undefined;
      if (settings) {
        await this.env.storage.saveConversationSettings('common', {
          conversationId: targetConversationId,
          name: settings.name
        });
        const target = this.findConversationEntity(targetConversationId);
        const conversation = target !== undefined ? this.world.get(target, Conversation) : undefined;
        if (target !== undefined && conversation) {
          this.world.add(target, Conversation, { ...conversation, title: settings.name });
        }
      }
    } catch (error) {
      console.warn(`[LimCode] Failed to copy common settings to fork "${targetConversationId}".`, error);
    }

    try {
      const llm = await this.env.storage.loadConversationSettings(sourceConversationId, 'llm');
      const settings = llm?.settings as ConversationLlmSettingsRecord | undefined;
      if (!settings) return;
      const copied: ConversationLlmSettingsRecord = {
        conversationId: targetConversationId,
        activeProviderConfigId: settings.activeProviderConfigId,
        ...(settings.modelOverrides ? { modelOverrides: { ...settings.modelOverrides } } : {})
      };
      await this.env.storage.saveConversationSettings('llm', copied);
      await this.applyConversationModelSettingsToWorld(copied);
    } catch (error) {
      console.warn(`[LimCode] Failed to copy LLM settings to fork "${targetConversationId}".`, error);
    }
  }

  private async afterConversationSettingsRead(stored: { conversationId: string; section: string; settings: unknown }): Promise<void> {
    if (stored.section !== 'llm') return;
    await this.applyConversationModelSettingsToWorld(stored.settings as ConversationLlmSettingsRecord | undefined);
  }

  private async afterConversationSettingsUpdate(stored: { conversationId: string; section: string; settings: unknown }): Promise<void> {
    if (stored.section !== 'llm') return;
    const settings = stored.settings as ConversationLlmSettingsRecord | undefined;
    await this.applyConversationModelSettingsToWorld(settings);
    const activeProviderConfigId = settings?.activeProviderConfigId?.trim();
    if (!activeProviderConfigId) return;

    await this.globalSettingsBridge.update({
      section: 'llm',
      settings: { activeProviderConfigId }
    });
  }

  private async applyConversationModelSettingsToWorld(settings: ConversationLlmSettingsRecord | undefined): Promise<void> {
    const conversationId = settings?.conversationId?.trim();
    const providerConfigId = settings?.activeProviderConfigId?.trim();
    if (!conversationId || !providerConfigId) return;
    const model = settings?.modelOverrides?.[providerConfigId]?.trim();
    if (!model) return;
    const provider = await this.env.storage.loadLlmProviderConfigById(providerConfigId);
    if (!provider || !modelExistsInProviderConfig(provider, model)) return;
    this.upsertConversationModelProfile(conversationId, {
      providerConfigId,
      provider: provider.provider,
      model
    });
  }

  private async afterGlobalSettingsUpdate(payload: { section: string; refreshMcpTools?: boolean }): Promise<void> {
    if (payload.section === 'mcpServers' || payload.section === 'common') {
      await this.refreshMcpRuntime(payload.refreshMcpTools === true);
    }
    if (payload.section === 'common') {
      // 数据根目录切换后，全局技能来源 <dataRoot>/skills 会变化，需重新扫描技能目录。
      await this.syncSkillCatalogResource();
      // 同理，全局规则来源 <dataRoot>/{AGENTS,CLAUDE}.md 也随数据根变化，需重新扫描规则。
      await this.syncRulesCatalogResource();
    }
  }

  private async refreshMcpRuntime(discover: boolean): Promise<void> {
    await this.env.mcp.refreshFromSettings({ discover });
    if (!this.disposing) this.syncMcpRuntimeResources();
  }

  private syncMcpRuntimeResources(): void {
    if (this.disposing) return;
    const builtinTools = this.env.tools.registry.filter((tool) => tool.declaration.source?.kind !== 'mcp');
    const mcpTools = dedupeMcpToolNames(this.env.mcp.runtimeTools(), builtinTools.map((tool) => tool.declaration.name));
    const mergedTools = [...builtinTools, ...mcpTools];
    this.env.tools.registry.splice(0, this.env.tools.registry.length, ...mergedTools);
    this.world.setResource(ToolRuntimeDefinitionsKey, this.env.tools.registry);
    this.world.setResource(ToolSchemasKey, schemasForTools(mergedTools));
    this.world.setResource(ToolDefinitionsKey, recordsForTools(mergedTools));
    this.world.setResource(McpToolSourcesKey, this.env.mcp.sourceRecords());
    this.requestSnapshot();
  }

  private async freezeLoadedConversationsToCurrentGlobalLlmDefault(): Promise<void> {
    let currentProviderConfigId = '';
    try {
      currentProviderConfigId = (await this.env.storage.loadActiveLlmProviderConfig()).id;
    } catch (error) {
      console.warn('[LimCode] Failed to resolve current global LLM default before update.', error);
      return;
    }
    if (!currentProviderConfigId) return;

    for (const conversationId of this.loadedConversationIds()) {
      try {
        const stored = await this.env.storage.loadConversationSettings(conversationId, 'llm');
        const settings = stored?.settings as import('../../shared/protocol').ConversationLlmSettingsRecord | undefined;
        if (settings?.activeProviderConfigId) continue;
        await this.env.storage.saveConversationSettings('llm', {
          conversationId,
          activeProviderConfigId: currentProviderConfigId,
          ...(settings?.modelOverrides ? { modelOverrides: settings.modelOverrides } : {})
        });
      } catch (error) {
        console.warn(`[LimCode] Failed to freeze LLM default for conversation "${conversationId}".`, error);
      }
    }
  }

  private async freezeLoadedConversationsToCurrentProviderModels(): Promise<void> {
    for (const conversationId of this.loadedConversationIds()) {
      try {
        const stored = await this.env.storage.loadConversationSettings(conversationId, 'llm');
        const settings = stored?.settings as import('../../shared/protocol').ConversationLlmSettingsRecord | undefined;
        if (!settings?.activeProviderConfigId) continue;
        if (settings.modelOverrides?.[settings.activeProviderConfigId]) continue;
        const provider = await this.env.storage.loadActiveLlmProviderConfig(conversationId);
        const model = provider.model?.trim();
        if (!model) continue;
        await this.env.storage.saveConversationSettings('llm', {
          conversationId,
          activeProviderConfigId: settings.activeProviderConfigId,
          modelOverrides: {
            ...(settings.modelOverrides ?? {}),
            [settings.activeProviderConfigId]: model
          }
        });
      } catch (error) {
        console.warn(`[LimCode] Failed to freeze LLM model for conversation "${conversationId}".`, error);
      }
    }
  }

  private loadedConversationIds(): string[] {
    return this.world
      .query(Conversation)
      .map((entity) => this.world.get(entity, Conversation)?.id)
      .filter((id): id is string => !!id);
  }

  private async syncSkillCatalogResource(): Promise<void> {
    await this.env.skills.refresh();
    if (this.disposing) return;
    this.world.setResource(SkillCatalogKey, this.env.skills.list());
    if (this.hydrated) this.requestSnapshot();
  }

  private async syncRulesCatalogResource(): Promise<void> {
    await this.env.rules.refresh();
    if (this.disposing) return;
    this.world.setResource(RulesCatalogKey, this.env.rules.list());
    if (this.hydrated) this.requestSnapshot();
  }

  private async saveRuleFile(scope: RuleScope, content: string): Promise<void> {
    await this.env.rules.writeAgents(scope, content);
    await this.syncRulesCatalogResource();
  }

  private flushPendingSnapshots(): void {
    if (this.pendingGlobalSnapshot) {
      this.pendingGlobalSnapshot = false;
      this.requestSnapshot();
    }

    const conversationIds = [...this.pendingSnapshotConversationIds];
    this.pendingSnapshotConversationIds.clear();
    for (const conversationId of conversationIds) this.requestSnapshot(conversationId);
  }

  private flushPendingHydrationMessages(): void {
    if (this.disposing) {
      this.pendingHydrationMessages.length = 0;
      return;
    }
    const pending = this.pendingHydrationMessages.splice(0);
    for (const item of pending) this.handleWebviewMessage(item.clientId, item.message);
  }

  private flushPendingDeferredSkeletonMessages(): void {
    if (this.disposing) {
      this.pendingDeferredSkeletonMessages.length = 0;
      return;
    }
    const pending = this.pendingDeferredSkeletonMessages.splice(0);
    for (const item of pending) this.handleWebviewMessage(item.clientId, item.message);
  }

  private primeConversationStreamState(conversationId: string, detail: ClientState): void {
    const syncState = this.world.tryGetResource(ClientSyncStateKey);
    if (!syncState) return;
    const streamId = conversationClientStateStreamId(conversationId);
    const stream = syncState.streams[streamId];
    if (!stream?.lastState) return;

    const nextStreamState = cloneClientState(stream.lastState);
    mergeClientStateRecords(nextStreamState, detail);
    this.world.setResource(ClientSyncStateKey, {
      ...syncState,
      streams: {
        ...syncState.streams,
        [streamId]: { ...stream, lastState: nextStreamState }
      }
    });
  }

  private syncWorkEnvironmentsFromWorkspaceFolders(): void {
    if (!this.hydrated || this.disposing) return;
    this.world.enqueue({
      type: WorkEnvironmentEventType.WorkspaceFoldersSynced,
      payload: { folders: this.getLocalWorkEnvironmentCandidates() }
    });
    this.requestSnapshot();
  }

  private getLocalWorkEnvironmentCandidates(): LocalWorkEnvironmentCandidate[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
      id: workEnvironmentIdFromUri(folder.uri.toString()),
      name: folder.name,
      uri: folder.uri.toString(),
      rootPath: folder.uri.fsPath,
      displayPath: folder.uri.fsPath || folder.uri.toString(),
      index
    }));
  }

  public async importWorkEnvironmentsFromVscode(): Promise<number> {
    const records = await loadRemoteServerWorkEnvironmentRecordsFromVscode();
    if (records.length === 0) return 0;
    this.world.enqueue({
      type: WorkEnvironmentEventType.ImportFromVscodeRequested,
      payload: { records }
    });
    this.requestSnapshot();
    return records.length;
  }



  private findDefaultAgent(): Entity | undefined {
    return this.world.query(Agent).find((entity) => this.world.get(entity, Agent)?.id === DEFAULT_AGENT_ID)
      ?? this.world.query(Agent)[0];
  }

  private findAgentEntity(agentId: string): Entity | undefined {
    return this.world.query(Agent).find((entity) => this.world.get(entity, Agent)?.id === agentId);
  }

  private activeSelectionForConversation(conversation: Entity): { entity: Entity; agent: Entity } | undefined {
    let selected: { entity: Entity; data: { agent: Entity; updatedAt: number } } | undefined;
    for (const entity of this.world.query(ConversationAgentSelection)) {
      const data = this.world.get(entity, ConversationAgentSelection);
      if (!data || data.role !== 'active' || data.conversation !== conversation) continue;
      if (!selected || data.updatedAt > selected.data.updatedAt || (data.updatedAt === selected.data.updatedAt && entity > selected.entity)) {
        selected = { entity, data };
      }
    }
    return selected ? { entity: selected.entity, agent: selected.data.agent } : undefined;
  }

  private resolveProjectFolderForNewConversation(projectFolderUri: string | undefined): ProjectFolderCandidateRecord | undefined {
    if (projectFolderUri) {
      const normalizedUri = projectFolderUri.trim();
      if (!normalizedUri) return undefined;
      const candidate = this.projectFolderCandidateForUri(projectFolderUri);
      return candidate ?? { uri: normalizedUri, name: projectFolderNameFromUri(normalizedUri), index: -1 };
    }

    const candidates = this.getProjectFolderCandidates();
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private projectFolderCandidateForUri(folderUri: string): ProjectFolderCandidateRecord | undefined {
    const normalized = folderUri.trim();
    return this.getProjectFolderCandidates().find((candidate) => candidate.uri === normalized);
  }

  private findConversationEntity(conversationId: string): Entity | undefined {
    return this.world.query(Conversation).find((entity) => this.world.get(entity, Conversation)?.id === conversationId);
  }

  private upsertConversationModelProfile(
    conversationId: string,
    input: { providerConfigId?: string; provider?: LlmProviderKind; model: string }
  ): void {
    const scopeId = conversationId.trim();
    const model = input.model.trim();
    if (!scopeId || !model) return;
    const conversation = this.findConversationEntity(scopeId);
    if (conversation === undefined) return;
    const now = Date.now();
    const existing = this.latestConversationModelProfileLink(conversation, scopeId);
    const profile = existing?.link.modelProfile ?? this.world.spawn();
    const profileId = existing ? this.world.get(profile, ModelProfile)?.id ?? modelProfileIdForConversation(scopeId) : modelProfileIdForConversation(scopeId);
    this.world.add(profile, ModelProfile, {
      id: profileId,
      name: '对话临时模型',
      ...(input.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      model
    });
    if (existing) {
      this.world.add(existing.entity, ModelProfileScopeLink, { ...existing.link, conversation, scopeId, modelProfile: profile, updatedAt: now });
      return;
    }
    const link = this.world.spawn();
    this.world.add(link, ModelProfileScopeLink, {
      id: modelProfileScopeLinkIdForConversation(scopeId),
      scopeKind: 'conversation',
      scopeId,
      conversation,
      modelProfile: profile,
      role: 'active',
      createdAt: now,
      updatedAt: now
    });
  }

  private latestConversationModelProfileLink(conversation: Entity, scopeId: string): { entity: Entity; link: ModelProfileScopeLinkData } | undefined {
    return this.world
      .query(ModelProfileScopeLink)
      .map((entity) => ({ entity, link: this.world.get(entity, ModelProfileScopeLink) }))
      .filter((item): item is { entity: Entity; link: ModelProfileScopeLinkData } => !!item.link && item.link.role === 'active' && item.link.scopeKind === 'conversation' && (item.link.conversation === conversation || item.link.scopeId === scopeId))
      .sort((left, right) => (right.link.updatedAt || right.link.createdAt) - (left.link.updatedAt || left.link.createdAt) || right.entity - left.entity)[0];
  }

  private collectConversationCascadeEntities(conversation: Entity, conversationId: string): Set<Entity> {
    const entities = new Set<Entity>([conversation]);
    const messages = this.collectMessagesForConversation(conversation);
    const revisions = this.collectRevisionsForMessages(messages);
    const toolCalls = this.collectToolCallsForMessages(messages);
    const toolCallEvents = this.collectToolCallEventsForToolCalls(toolCalls);
    const runPolicies = new Set<Entity>();
    const runs = this.collectRunsForConversationCascade(conversation, conversationId, messages, revisions, toolCalls, runPolicies, entities);

    addAll(entities, messages);
    addAll(entities, revisions);
    addAll(entities, toolCalls);
    addAll(entities, toolCallEvents);

    for (const entity of this.world.query(MessageCurrentRevisionLink)) {
      const link = this.world.get(entity, MessageCurrentRevisionLink);
      if (!link) continue;
      if (messages.has(link.message) || revisions.has(link.revision)) {
        entities.add(entity);
        revisions.add(link.revision);
        entities.add(link.revision);
      }
    }

    for (const entity of this.world.query(AgentConversationLink)) {
      const link = this.world.get(entity, AgentConversationLink);
      if (link?.conversation === conversation) entities.add(entity);
    }

    for (const entity of this.world.query(ConversationAgentSelection)) {
      const selection = this.world.get(entity, ConversationAgentSelection);
      if (selection?.conversation === conversation) entities.add(entity);
    }

    for (const entity of this.world.query(ConversationWorkflowSelection)) {
      const selection = this.world.get(entity, ConversationWorkflowSelection);
      if (selection?.conversation === conversation) entities.add(entity);
    }

    for (const entity of this.world.query(ConversationProjectLink)) {
      const link = this.world.get(entity, ConversationProjectLink);
      if (link?.conversation === conversation) entities.add(entity);
    }

    for (const entity of this.world.query(ConversationOriginLink)) {
      const link = this.world.get(entity, ConversationOriginLink);
      if (link?.conversation === conversation) entities.add(entity);
    }

    for (const entity of this.world.query(ConversationReuseLink)) {
      const link = this.world.get(entity, ConversationReuseLink);
      if (link?.conversation === conversation) entities.add(entity);
    }

    for (const entity of this.world.query(ConversationBranchLink)) {
      const link = this.world.get(entity, ConversationBranchLink);
      if (!link) continue;
      if (link.sourceConversation === conversation || link.targetConversation === conversation || (link.sourceRevision !== undefined && revisions.has(link.sourceRevision))) {
        entities.add(entity);
      }
    }

    this.collectRunOwnedEntities(runs, runPolicies, entities);
    return entities;
  }

  private collectMessagesForConversation(conversation: Entity): Set<Entity> {
    const messages = new Set<Entity>();
    for (const entity of this.world.query(Message, PartOf)) {
      if (this.world.get(entity, PartOf)?.parent === conversation) messages.add(entity);
    }
    return messages;
  }

  private collectRevisionsForMessages(messages: ReadonlySet<Entity>): Set<Entity> {
    const revisions = new Set<Entity>();
    for (const entity of this.world.query(MessageRevision, PartOf)) {
      if (messages.has(this.world.get(entity, PartOf)?.parent ?? -1)) revisions.add(entity);
    }
    return revisions;
  }

  private collectToolCallsForMessages(messages: ReadonlySet<Entity>): Set<Entity> {
    const toolCalls = new Set<Entity>();
    for (const entity of this.world.query(ToolCall, PartOf)) {
      if (messages.has(this.world.get(entity, PartOf)?.parent ?? -1)) toolCalls.add(entity);
    }
    return toolCalls;
  }

  private collectToolCallEventsForToolCalls(toolCalls: ReadonlySet<Entity>): Set<Entity> {
    const events = new Set<Entity>();
    for (const entity of this.world.query(ToolCallEvent, PartOf)) {
      if (toolCalls.has(this.world.get(entity, PartOf)?.parent ?? -1)) events.add(entity);
    }
    return events;
  }

  private collectRunsForConversationCascade(
    conversation: Entity,
    conversationId: string,
    messages: ReadonlySet<Entity>,
    revisions: ReadonlySet<Entity>,
    toolCalls: ReadonlySet<Entity>,
    runPolicies: Set<Entity>,
    entities: Set<Entity>
  ): Set<Entity> {
    const runs = new Set<Entity>();
    let changed = true;
    while (changed) {
      changed = false;
      const addRun = (run: Entity | undefined): void => {
        if (run === undefined || runs.has(run)) return;
        runs.add(run);
        changed = true;
      };
      const addRunPolicy = (policy: Entity | undefined): void => {
        if (policy === undefined || runPolicies.has(policy)) return;
        runPolicies.add(policy);
        entities.add(policy);
        changed = true;
      };

      for (const entity of this.world.query(LlmRequest)) {
        const request = this.world.get(entity, LlmRequest);
        if (!request) continue;
        if (request.conversation === conversation || messages.has(request.modelMessage) || runs.has(request.run)) {
          entities.add(entity);
          addRun(request.run);
        }
      }

      for (const entity of this.world.query(AgentRunSourceLink)) {
        const link = this.world.get(entity, AgentRunSourceLink);
        if (!link) continue;
        const matches = link.sourceConversation === conversation
          || (link.sourceMessage !== undefined && messages.has(link.sourceMessage))
          || (link.sourceToolCall !== undefined && toolCalls.has(link.sourceToolCall))
          || (link.sourceRun !== undefined && runs.has(link.sourceRun))
          || runs.has(link.run);
        if (matches) {
          entities.add(entity);
          addRun(link.run);
        }
      }

      for (const entity of this.world.query(AgentRunTargetLink)) {
        const link = this.world.get(entity, AgentRunTargetLink);
        if (!link) continue;
        if (link.conversation === conversation || runs.has(link.run)) {
          entities.add(entity);
          addRun(link.run);
        }
      }

      for (const entity of this.world.query(MessageRunLink)) {
        const link = this.world.get(entity, MessageRunLink);
        if (!link) continue;
        if (messages.has(link.message) || runs.has(link.run)) {
          entities.add(entity);
          addRun(link.run);
        }
      }

      for (const entity of this.world.query(ToolCallRunLink)) {
        const link = this.world.get(entity, ToolCallRunLink);
        if (!link) continue;
        if (toolCalls.has(link.toolCall) || runs.has(link.run)) {
          entities.add(entity);
          addRun(link.run);
        }
      }

      for (const entity of this.world.query(AgentRunInputRevision)) {
        const input = this.world.get(entity, AgentRunInputRevision);
        if (!input) continue;
        if (input.conversation === conversation || revisions.has(input.revision) || runs.has(input.run)) {
          entities.add(entity);
          addRun(input.run);
        }
      }

      for (const entity of this.world.query(RunConversationPolicy)) {
        const policy = this.world.get(entity, RunConversationPolicy);
        if (!policy) continue;
        if (policy.conversationId === conversationId || policy.branchFromConversationId === conversationId) addRunPolicy(entity);
      }

      for (const entity of this.world.query(RunDeliveryPolicy)) {
        const policy = this.world.get(entity, RunDeliveryPolicy);
        if (!policy) continue;
        if (policy.targetConversation === conversation || (policy.targetToolCall !== undefined && toolCalls.has(policy.targetToolCall))) addRunPolicy(entity);
      }

      for (const entity of this.world.query(RunConversationPolicyLink)) this.collectRunPolicyLink(entity, RunConversationPolicyLink, runs, runPolicies, entities, addRun, addRunPolicy);
      for (const entity of this.world.query(RunContextPolicyLink)) this.collectRunPolicyLink(entity, RunContextPolicyLink, runs, runPolicies, entities, addRun, addRunPolicy);
      for (const entity of this.world.query(RunDeliveryPolicyLink)) this.collectRunPolicyLink(entity, RunDeliveryPolicyLink, runs, runPolicies, entities, addRun, addRunPolicy);
      for (const entity of this.world.query(RunEditPolicyLink)) this.collectRunPolicyLink(entity, RunEditPolicyLink, runs, runPolicies, entities, addRun, addRunPolicy);
    }
    return runs;
  }

  private collectRunPolicyLink<T extends { run: Entity; policy: Entity }>(
    entity: Entity,
    component: ComponentType<T>,
    runs: ReadonlySet<Entity>,
    runPolicies: ReadonlySet<Entity>,
    entities: Set<Entity>,
    addRun: (run: Entity | undefined) => void,
    addRunPolicy: (policy: Entity | undefined) => void
  ): void {
    const link = this.world.get(entity, component);
    if (!link) return;
    if (runs.has(link.run) || runPolicies.has(link.policy)) {
      entities.add(entity);
      addRun(link.run);
      addRunPolicy(link.policy);
    }
  }

  private collectConversationOriginsByConversation(): Map<Entity, ConversationOriginLinkRecord> {
    const result = new Map<Entity, ConversationOriginLinkRecord>();
    for (const entity of this.world.query(ConversationOriginLink)) {
      const link = this.world.get(entity, ConversationOriginLink);
      if (!link) continue;
      const conversation = this.world.get(link.conversation, Conversation);
      if (!conversation?.id) continue;
      const existing = result.get(link.conversation);
      if (existing && (existing.createdAt < link.createdAt || (existing.createdAt === link.createdAt && existing.id.localeCompare(link.id) <= 0))) continue;

      const sourceAgentId = (link.sourceAgent !== undefined ? this.world.get(link.sourceAgent, Agent)?.id : undefined) ?? link.sourceAgentId;
      const sourceConversationId = (link.sourceConversation !== undefined ? this.world.get(link.sourceConversation, Conversation)?.id : undefined) ?? link.sourceConversationId;
      const sourceMessageId = (link.sourceMessage !== undefined ? this.world.get(link.sourceMessage, Message)?.id : undefined) ?? link.sourceMessageId;
      const sourceToolCallId = (link.sourceToolCall !== undefined ? this.world.get(link.sourceToolCall, ToolCall)?.id : undefined) ?? link.sourceToolCallId;
      const sourceRunId = (link.sourceRun !== undefined ? this.world.get(link.sourceRun, AgentRun)?.id : undefined) ?? link.sourceRunId;
      result.set(link.conversation, {
        id: link.id,
        conversationId: conversation.id,
        originKind: link.originKind,
        ...(link.sourceKind ? { sourceKind: link.sourceKind } : {}),
        ...(sourceAgentId ? { sourceAgentId } : {}),
        ...(sourceConversationId ? { sourceConversationId } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceToolCallId ? { sourceToolCallId } : {}),
        ...(sourceRunId ? { sourceRunId } : {}),
        createdAt: link.createdAt,
        updatedAt: link.updatedAt
      });
    }
    return result;
  }

  private collectRunOwnedEntities(runs: ReadonlySet<Entity>, runPolicies: ReadonlySet<Entity>, entities: Set<Entity>): void {
    addAll(entities, runs);
    addAll(entities, runPolicies);

    for (const entity of this.world.query(AgentRun)) if (runs.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunConversationPolicy)) if (runPolicies.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunContextPolicy)) if (runPolicies.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunDeliveryPolicy)) if (runPolicies.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunEditPolicy)) if (runPolicies.has(entity)) entities.add(entity);

    for (const entity of this.world.query(RunWorkflowLink)) if (runs.has(this.world.get(entity, RunWorkflowLink)?.run ?? -1)) entities.add(entity);
    for (const entity of this.world.query(RunSystemPromptLink)) if (runs.has(this.world.get(entity, RunSystemPromptLink)?.run ?? -1)) entities.add(entity);
    for (const entity of this.world.query(RunModelProfileLink)) if (runs.has(this.world.get(entity, RunModelProfileLink)?.run ?? -1)) entities.add(entity);
    for (const entity of this.world.query(RunToolPolicyLink)) if (runs.has(this.world.get(entity, RunToolPolicyLink)?.run ?? -1)) entities.add(entity);

  }

  private collectProjectsByConversation(): Map<Entity, { uri: string; name: string }> {
    const result = new Map<Entity, { uri: string; name: string }>();
    for (const linkEntity of this.world.query(ConversationProjectLink)) {
      const link = this.world.get(linkEntity, ConversationProjectLink);
      if (!link || link.role !== 'primary') continue;
      const project = this.world.get(link.projectContext, ProjectContext);
      if (!project) continue;
      result.set(link.conversation, { uri: project.uri, name: project.name });
    }
    return result;
  }


  private collectMessagesByConversation(): Map<Entity, MessageData[]> {
    const result = new Map<Entity, MessageData[]>();
    for (const messageEntity of this.world.query(Message)) {
      const message = this.world.get(messageEntity, Message);
      const partOf = this.world.get(messageEntity, PartOf);
      if (!message || !partOf) continue;
      const list = result.get(partOf.parent) ?? [];
      list.push(message);
      result.set(partOf.parent, list);
    }
    for (const messages of result.values()) messages.sort(compareMessagesBySeq);
    return result;
  }

  private collectAgentNamesByConversation(): Map<Entity, string> {
    const result = new Map<Entity, string>();
    for (const linkEntity of this.world.query(AgentConversationLink)) {
      const link = this.world.get(linkEntity, AgentConversationLink);
      if (!link) continue;
      if (result.has(link.conversation) && link.role !== 'default') continue;
      const agent = this.world.get(link.agent, Agent);
      if (!agent?.name) continue;
      result.set(link.conversation, agent.name);
    }
    return result;
  }

  private collectRunSummariesByConversation(): Map<Entity, { status: AgentRunStatus; label: string; updatedAt: number }> {
    const result = new Map<Entity, { status: AgentRunStatus; label: string; updatedAt: number }>();
    for (const linkEntity of this.world.query(AgentRunTargetLink)) {
      const link = this.world.get(linkEntity, AgentRunTargetLink);
      if (!link) continue;
      const run = this.world.get(link.run, AgentRun);
      if (!run || !isActiveAgentRunStatus(run.status)) continue;
      const existing = result.get(link.conversation);
      if (existing && existing.updatedAt >= run.updatedAt) continue;
      result.set(link.conversation, {
        status: run.status,
        label: labelForAgentRunStatus(run.status),
        updatedAt: run.updatedAt
      });
    }
    return result;
  }
}

function compareConversationHistoryEntries(left: SidebarConversationHistoryEntry, right: SidebarConversationHistoryEntry): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || left.title.localeCompare(right.title, 'zh-CN')
    || left.id.localeCompare(right.id, 'zh-CN');
}

function historyEntryMatchesScope(entry: SidebarConversationHistoryEntry, scope: ConversationHistoryScope): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'unbound') return !entry.projectFolderUri;
  return entry.projectFolderUri === scope.folderUri;
}

function compareMessagesBySeq(left: MessageData, right: MessageData): number {
  return left.seq - right.seq || left.createdAt - right.createdAt;
}

function latestMessage(messages: MessageData[]): MessageData | undefined {
  return messages.reduce<MessageData | undefined>((latest, message) => {
    if (!latest) return message;
    return message.createdAt > latest.createdAt || (message.createdAt === latest.createdAt && message.seq > latest.seq)
      ? message
      : latest;
  }, undefined);
}

function messagePreview(message: MessageData): string {
  const text = normalizeText(textPreview(message.content));
  if (text) return truncateText(text, 72);
  const state = aiPreviewState(message);
  return message.role === 'user' ? '用户消息' : state === 'pending' ? '响应中' : '空响应';
}

function aiPreviewState(message: MessageData): 'pending' | 'empty' | undefined {
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

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeConversationTitle(title: string): string {
  return truncateText(normalizeText(title) || '新对话', 80);
}


function projectFolderNameFromUri(uri: string): string {
  try {
    const parsed = vscode.Uri.parse(uri);
    const normalizedPath = parsed.fsPath || parsed.path || uri;
    const withoutTrailingSlash = normalizedPath.replace(/[\\/]+$/g, '');
    const name = withoutTrailingSlash.split(/[\\/]/).pop()?.trim();
    return name || uri;
  } catch {
    const withoutTrailingSlash = uri.replace(/[\\/]+$/g, '');
    return withoutTrailingSlash.split(/[\\/]/).pop()?.trim() || uri;
  }
}

function addAll<T>(target: Set<T>, source: Iterable<T>): void {
  for (const item of source) target.add(item);
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'stale';
}

function labelForAgentRunStatus(status: AgentRunStatus): string {
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
function isPassFlushEffect(effect: WorldEffect): boolean {
  const kind = (effect as { kind?: string }).kind;
  return kind === 'client.patch'
    || kind === 'client.snapshot'
    || kind === 'client.transientNotice'
    || kind === 'llm.resolveInvocation'
    || kind === 'llm.start'
    || kind === 'llm.compact'
    || kind === 'llm.abort'
    || kind === 'tool.run'
    || kind === 'tool.change.apply'
    || kind === 'tool.abort'
    || kind === 'tool.background'
    || kind === 'checkpoint.create';
}

function mainPanelConversationId(meta: WebviewClientMeta): string | undefined {
  if (meta.kind !== 'mainPanel' && meta.kind !== 'planDetail') return undefined;
  return meta.conversationId?.trim() || DEFAULT_CONVERSATION_ID;
}

function modelProfileIdForConversation(conversationId: string): string { return `model-profile:conversation:${conversationId}`; }
function modelProfileScopeLinkIdForConversation(conversationId: string): string { return `model-profile-scope:conversation:${conversationId}`; }
function modelExistsInProviderConfig(config: { model?: string; models: Array<{ id: string }> }, model: string): boolean {
  const id = model.trim();
  if (!id) return false;
  return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
}

function shouldDeferUntilHydrated(message: WebviewToExtensionMessage): boolean {
  switch (message.type) {
    case 'chat.abort':
    case 'llm.retry.cancel':
    case 'message.edit':
    case 'message.deleteFrom':
    case 'message.retryFrom':
    case 'agent.create':
    case 'agent.update':
    case 'agent.delete':
    case 'conversation.agent.select':
    case 'systemPrompt.scope.set':
    case 'systemPrompt.scope.clear':
    case 'runtimeContext.scope.set':
    case 'runtimeContext.scope.clear':
    case 'runtimeContext.refresh':
    case 'runtimeContext.snapshot.clear':
    case 'modelProfile.scope.set':
    case 'modelProfile.scope.clear':
    case 'toolPolicy.scope.set':
    case 'toolPolicy.scope.clear':
    case 'skillPolicy.scope.set':
    case 'skillPolicy.scope.clear':
    case 'planReviewPolicy.scope.set':
    case 'planReviewPolicy.scope.clear':
    case 'checkpointPolicy.scope.set':
    case 'checkpointPolicy.scope.clear':
    case 'tool.execution.approve':
    case 'tool.execution.reject':
    case 'tool.change.apply':
    case 'tool.change.reject':
    case 'tool.result.submit':
    case 'tool.result.reject':
    case 'agentRun.cancel':
    case 'agentRun.pause':
    case 'agentRun.resume':
    case 'agentRun.retry':
    case 'agentRun.regenerate':
    case 'agentRun.markStale':
    case 'workflow.create':
    case 'workflow.update':
    case 'workflow.delete':
    case 'conversation.workflow.select':
    case 'conversation.project.set':
    case 'workEnvironment.select':
    case 'workEnvironment.upsert':
    case 'workEnvironment.remove':
    case 'workEnvironment.importFromVscode':
    case 'workEnvironmentPolicy.scope.set':
    case 'workEnvironmentPolicy.scope.clear':
    case 'client.resync':
      return true;
    default:
      return false;
  }
}

function shouldDeferUntilDeferredSkeleton(message: WebviewToExtensionMessage): boolean {
  switch (message.type) {
    case 'agent.create':
    case 'agent.update':
    case 'agent.delete':
    case 'conversation.agent.select':
    case 'systemPrompt.scope.set':
    case 'systemPrompt.scope.clear':
    case 'runtimeContext.scope.set':
    case 'runtimeContext.scope.clear':
    case 'runtimeContext.refresh':
    case 'runtimeContext.snapshot.clear':
    case 'modelProfile.scope.set':
    case 'modelProfile.scope.clear':
    case 'workflow.create':
    case 'workflow.update':
    case 'workflow.delete':
    case 'conversation.workflow.select':
    case 'toolPolicy.scope.set':
    case 'toolPolicy.scope.clear':
    case 'skillPolicy.scope.set':
    case 'skillPolicy.scope.clear':
    case 'workEnvironment.select':
    case 'workEnvironment.upsert':
    case 'workEnvironment.remove':
    case 'workEnvironment.importFromVscode':
    case 'workEnvironmentPolicy.scope.set':
    case 'workEnvironmentPolicy.scope.clear':
    case 'planReviewPolicy.scope.set':
    case 'planReviewPolicy.scope.clear':
    case 'checkpointPolicy.scope.set':
    case 'checkpointPolicy.scope.clear':
      return true;
    default:
      return false;
  }
}

function cloneClientState(state: ClientState): ClientState {
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state)) as ClientState;
}

function mergeClientStateRecords(target: ClientState, source: ClientState): void {
  for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
    const targetRecords = target[tableKey] as Array<{ id: string }>;
    const sourceRecords = source[tableKey] as Array<{ id: string }>;
    if (sourceRecords.length === 0) continue;
    const indexById = new Map(targetRecords.map((record, index) => [record.id, index]));
    for (const record of sourceRecords) upsertClientStateRecord(targetRecords, indexById, record);
  }
}

function upsertClientStateRecord(list: Array<{ id: string }>, indexById: Map<string, number>, record: { id: string }): void {
  const index = indexById.get(record.id);
  const next = typeof structuredClone === 'function'
    ? structuredClone(record)
    : JSON.parse(JSON.stringify(record));
  if (index !== undefined) {
    list[index] = next;
    return;
  }
  indexById.set(record.id, list.length);
  list.push(next);
}
