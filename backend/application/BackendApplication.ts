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
  modePlugin,
  agentRunPlugin,
  checkpointPlugin,
  compressionPlugin,
  llmPlugin,
  requestSpawnAgent,
  projectPlugin,
  runtimeContextPlugin,
  toolsPlugin,
  workEnvironmentPlugin
} from '../world/modules';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import { Agent, AgentConversationLink, ConversationAgentSelection } from '../world/modules/agent/components';
import {
  Conversation,
  ConversationBranchLink,
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
  RunModeLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../world/modules/agentRun/components';
import { AgentRunEventType } from '../world/modules/agentRun/events';
import { setConversationProject } from '../world/modules/project/bundles';
import { ConversationProjectLink, ProjectContext } from '../world/modules/project/components';
import { upsertGlobalModeSelection } from '../world/modules/mode/bundles';
import { ConversationModeSelection } from '../world/modules/mode/components';
import { ToolCall, ToolCallEvent } from '../world/modules/tools/components';
import { WorkEnvironmentEventType, workEnvironmentIdFromUri } from '../world/modules/workEnvironment';
import type { LocalWorkEnvironmentCandidate } from '../world/modules/workEnvironment';
import { clientSyncPlugin, registerClientSyncSystems } from '../world/clientSync';
import { storageProjectionPlugin } from '../world/storageProjection';
import { EffectHandlerRegistry, registerApplicationEffectHandlers } from './effectHandlers';
import { flushEffects, flushEffectsWhere } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import { GLOBAL_SETTINGS_SECTIONS, createMessageId } from '../../shared/protocol';
import type {
  AgentRunSourceKind,
  AgentRunStatus,
  CheckpointMaintenanceSettingsRecord,
  BridgeClientId,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  MessageContent,
  ProjectFolderCandidateRecord,
  ConversationOriginKind,
  SidebarHistoryScopeKind,
  SidebarConversationHistoryEntry,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../shared/protocol';
import { createRuntimeEnv } from './createRuntimeEnv';
import { createDefaultAgentSpawnRequest, DEFAULT_AGENT_ID } from './defaults';
import { hydrateClientStateSkeleton, hydrateConversationDetail } from './clientStateHydration';
import { ClientStatePersistence } from './ClientStatePersistence';
import { GlobalSettingsBridge } from './GlobalSettingsBridge';
import { ConversationSettingsBridge } from './ConversationSettingsBridge';
import { WebviewClientRegistry } from './WebviewClientRegistry';
import { WebviewMessageRouter } from './WebviewMessageRouter';
import { conversationCreatedAtFromId, createNewConversationTitle, displayConversationTitle } from '../../shared/conversationTitle';
import { loadRemoteServerWorkEnvironmentRecordsFromVscode } from './workEnvironments/vscodeSshImport';

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
  private hydrated = false;
  private resolveHydrated: () => void = () => undefined;
  private readonly hydratedReady = new Promise<void>((resolve) => { this.resolveHydrated = resolve; });
  private pendingGlobalSnapshot = false;
  private readonly pendingSnapshotConversationIds = new Set<string>();
  private readonly pendingHydrationMessages: Array<{ clientId: BridgeClientId; message: WebviewToExtensionMessage }> = [];
  private readonly renderLoadedConversationDetails = new Set<string>();
  private readonly runHistoryLoadedConversationDetails = new Set<string>();
  private readonly conversationHistoryChangedEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  public readonly onDidChangeConversationHistory = this.conversationHistoryChangedEmitter.event;

  public constructor(context: vscode.ExtensionContext) {
    const { env, toolSchemas, toolDefinitions } = createRuntimeEnv(context);
    this.env = env;
    this.persistence = new ClientStatePersistence(this.world, this.env.storage, {
      renderLoadedConversationIds: () => this.renderLoadedConversationDetails,
      runHistoryLoadedConversationIds: () => this.runHistoryLoadedConversationDetails
    });
    this.globalSettingsBridge = new GlobalSettingsBridge({
      storage: this.env.storage,
      webview: this.env.webview,
      beforeDataRootChange: () => this.persistence.persistImmediately({ force: true, throwOnError: true })
    });
    this.conversationSettingsBridge = new ConversationSettingsBridge({
      world: this.world,
      storage: this.env.storage,
      webview: this.env.webview,
      requestSnapshot: (conversationId) => this.requestSnapshot(conversationId)
    });
    this.webviewRouter = new WebviewMessageRouter({
      world: this.world,
      webview: this.env.webview,
      clients: this.webviewClients,
      storage: this.env.storage,
      llm: this.env.llm,
      globalSettingsBridge: this.globalSettingsBridge,
      conversationSettingsBridge: this.conversationSettingsBridge,
      isHydrated: () => this.hydrated,
      requestSnapshot: (conversationId) => this.requestSnapshot(conversationId),
      ensureConversationDetailLoaded: (conversationId) => this.ensureConversationDetailLoaded(conversationId),
      getProjectFolderCandidates: () => this.getProjectFolderCandidates(),
      setConversationProjectFolder: (input) => this.setConversationProjectFolder(input),
      importWorkEnvironmentsFromVscode: () => this.importWorkEnvironmentsFromVscode()
    });

    registerApplicationEffectHandlers(this.effectHandlers);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.syncWorkEnvironmentsFromWorkspaceFolders();
    }));

    this.scheduler = new Scheduler(this.world, {
      applyEffect: (effect) => this.outbox.push(effect as WorldEffect),
      afterPass: () => {
        flushEffectsWhere(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers, isRealtimeClientEffect);
      },
      afterTick: () => {
        flushEffects(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers);
        this.persistence.queuePersist();
        this.conversationHistoryChangedEmitter.fire();
      }
    }, {
      parallelWorkers: true,
      workerPoolSize: 2
    });

    installWorldPlugins(
      { world: this.world, scheduler: this.scheduler },
      [commonPlugin(), clientSyncPlugin(), storageProjectionPlugin(), agentPlugin(), modePlugin(), projectPlugin(), workEnvironmentPlugin(), runtimeContextPlugin(), checkpointPlugin(), compressionPlugin(), llmPlugin(), toolsPlugin({ toolSchemas, toolDefinitions, toolRuntimeDefinitions: this.env.tools.registry }), chatPlugin(), agentRunPlugin()]
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

    upsertGlobalModeSelection(this.world, conversation, conversationId);

    const projectFolder = this.resolveProjectFolderForNewConversation(options.projectFolderUri);
    if (projectFolder) setConversationProject(this.world, { conversation, uri: projectFolder.uri, name: projectFolder.name });

    this.renderLoadedConversationDetails.add(conversationId);
    this.runHistoryLoadedConversationDetails.add(conversationId);
    await this.upsertConversationHistoryEntry(conversationId);
    this.requestSnapshot();
    return conversationId;
  }

  /** 侧边栏只读投影：按最近消息时间排序的对话历史列表。 */
  public getConversationHistoryEntries(): SidebarConversationHistoryEntry[] {
    const messagesByConversation = this.collectMessagesByConversation();
    const agentNamesByConversation = this.collectAgentNamesByConversation();
    const runSummariesByConversation = this.collectRunSummariesByConversation();
    const projectsByConversation = this.collectProjectsByConversation();
    const originsByConversation = this.collectConversationOriginsByConversation();
    const entries: SidebarConversationHistoryEntry[] = [];

    for (const entity of this.world.query(Conversation)) {
      const conversation = this.world.get(entity, Conversation);
      if (!conversation?.id) continue;
      const messages = messagesByConversation.get(entity) ?? [];
      const latest = latestMessage(messages);
      const agentName = agentNamesByConversation.get(entity);
      const runSummary = runSummariesByConversation.get(entity);
      const project = projectsByConversation.get(entity);
      const origin = originsByConversation.get(entity);
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
      if (origin) {
        entry.originKind = origin.originKind;
        if (origin.originSourceKind) entry.originSourceKind = origin.originSourceKind;
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
    void this.env.storage.removeConversationHistoryEntry(conversationId);
    this.requestSnapshot();
    this.requestSnapshot(conversationId);
    return true;
  }

  public abortConversation(conversationId: string): boolean {
    const entity = this.findConversationEntity(conversationId);
    if (entity === undefined) return false;

    this.world.enqueue({ type: ChatEventType.Abort, payload: { conversationId } });
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
    return clientId;
  }

  public async ensureConversationDetailLoaded(conversationId: string): Promise<void> {
    if (!conversationId) return;
    if (!this.hydrated) await this.waitUntilHydrated();
    if (this.renderLoadedConversationDetails.has(conversationId)) return;
    const detail = await this.env.storage.loadConversationDetail(conversationId, { includeRunHistory: false });
    const hydrated = detail ? await hydrateConversationDetail(this.world, detail, conversationId) : false;
    if (hydrated || this.findConversationEntity(conversationId) !== undefined) this.renderLoadedConversationDetails.add(conversationId);
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
    return this.env.storage.loadConversationHistoryPage({ scope, cursor: input.cursor, limit: input.limit });
  }

  private resolveHistoryScope(scopeKind: SidebarHistoryScopeKind, projectFolderUri: string | undefined): ConversationHistoryScope {
    if (scopeKind === 'all') return { kind: 'all' };
    if (scopeKind === 'unbound') return { kind: 'unbound' };
    if (scopeKind === 'project' && projectFolderUri?.trim()) return { kind: 'project', folderUri: projectFolderUri.trim() };
    return this.getCurrentProjectHistoryScope();
  }


  private async upsertConversationHistoryEntry(conversationId: string): Promise<void> {
    const entry = this.getConversationHistoryEntries().find((candidate) => candidate.id === conversationId);
    if (!entry) return;
    await this.env.storage.upsertConversationHistoryEntry(entry);
  }


  public waitUntilHydrated(): Promise<void> {
    return this.hydrated ? Promise.resolve() : this.hydratedReady;
  }

  public detachWebview(clientId: BridgeClientId): void {
    this.env.webview.detach(clientId);
    this.webviewClients.unregister(clientId);
  }

  public handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    if (!this.hydrated && shouldDeferUntilHydrated(message)) {
      this.pendingHydrationMessages.push({ clientId, message });
      return;
    }
    this.webviewRouter.handle(clientId, message);
  }

  public dispose(): void {
    this.scheduler.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.env.webview.detachAll();
    this.webviewClients.clear();
    void this.persistence.persistImmediately();
  }

  private async initializeClientState(): Promise<void> {
    try {
      await this.env.storage.ensureReady();
      const restored = await this.env.storage.loadClientStateSkeleton({ profile: 'startup' });
      if (restored && await hydrateClientStateSkeleton(this.world, restored)) {
        this.persistence.rememberPersistedState(restored);
      } else {
        requestSpawnAgent(this.world, createDefaultAgentSpawnRequest());
      }
    } catch (error) {
      console.warn('[LimCode] Failed to initialize stored chat state. Starting with a fresh conversation.', error);
      requestSpawnAgent(this.world, createDefaultAgentSpawnRequest());
    } finally {
      this.hydrated = true;
      this.persistence.enable();
      this.flushPendingSnapshots();
      this.flushPendingHydrationMessages();
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        void this.globalSettingsBridge.postSnapshot(undefined, section);
      }
      // 工作环境与策略属于 deferred skeleton。必须先加载已保存策略，再同步 VS Code workspace folders，
      // 否则启动时会临时生成只包含当前本地目录的全局策略，覆盖用户勾选的 SSH / 允许列表。
      this.startDeferredClientStateSkeletonLoad();
      this.startCheckpointShadowAutoCleanup();
      this.resolveHydrated();
    }
  }

  private startDeferredClientStateSkeletonLoad(): void {
    void this.env.storage.loadClientStateSkeleton({ profile: 'deferred' })
      .then(async (deferred) => {
        if (deferred) {
          const hydrated = await hydrateClientStateSkeleton(this.world, deferred, { allowDefaults: false, resetMessageSeq: false });
          if (hydrated) {
            this.requestSnapshot();
            this.conversationHistoryChangedEmitter.fire();
          }
        }
      })
      .catch((error) => console.warn('[LimCode] Failed to lazy-load deferred client state skeleton.', error))
      .finally(() => {
        this.syncWorkEnvironmentsFromWorkspaceFolders();
      });
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

  private requestSnapshot(conversationId?: string): void {
    if (!this.hydrated) {
      if (conversationId) this.pendingSnapshotConversationIds.add(conversationId);
      else this.pendingGlobalSnapshot = true;
      return;
    }
    this.world.enqueue({ type: ClientSyncEventType.Resync, payload: conversationId ? { conversationId } : {} });
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
    const pending = this.pendingHydrationMessages.splice(0);
    for (const item of pending) this.webviewRouter.handle(item.clientId, item.message);
  }

  private syncWorkEnvironmentsFromWorkspaceFolders(): void {
    if (!this.hydrated) return;
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

    for (const entity of this.world.query(ConversationModeSelection)) {
      const selection = this.world.get(entity, ConversationModeSelection);
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

  private collectConversationOriginsByConversation(): Map<Entity, { originKind: ConversationOriginKind; originSourceKind?: AgentRunSourceKind }> {
    const result = new Map<Entity, { originKind: ConversationOriginKind; originSourceKind?: AgentRunSourceKind; createdAt: number }>();
    for (const entity of this.world.query(ConversationOriginLink)) {
      const link = this.world.get(entity, ConversationOriginLink);
      if (!link) continue;
      const existing = result.get(link.conversation);
      if (existing && existing.createdAt <= link.createdAt) continue;
      result.set(link.conversation, {
        originKind: link.originKind,
        ...(link.sourceKind ? { originSourceKind: link.sourceKind } : {}),
        createdAt: link.createdAt
      });
    }
    return new Map([...result].map(([conversation, origin]) => [conversation, {
      originKind: origin.originKind,
      ...(origin.originSourceKind ? { originSourceKind: origin.originSourceKind } : {})
    }]));
  }

  private collectRunOwnedEntities(runs: ReadonlySet<Entity>, runPolicies: ReadonlySet<Entity>, entities: Set<Entity>): void {
    addAll(entities, runs);
    addAll(entities, runPolicies);

    for (const entity of this.world.query(AgentRun)) if (runs.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunConversationPolicy)) if (runPolicies.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunContextPolicy)) if (runPolicies.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunDeliveryPolicy)) if (runPolicies.has(entity)) entities.add(entity);
    for (const entity of this.world.query(RunEditPolicy)) if (runPolicies.has(entity)) entities.add(entity);

    for (const entity of this.world.query(RunModeLink)) if (runs.has(this.world.get(entity, RunModeLink)?.run ?? -1)) entities.add(entity);
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

function isRealtimeClientEffect(effect: WorldEffect): boolean {
  const kind = (effect as { kind?: string }).kind;
  return kind === 'client.patch' || kind === 'client.snapshot';
}

function shouldDeferUntilHydrated(message: WebviewToExtensionMessage): boolean {
  switch (message.type) {
    case 'chat.send':
    case 'chat.abort':
    case 'message.edit':
    case 'message.deleteFrom':
    case 'message.retryFrom':
    case 'toolPolicy.scope.set':
    case 'toolPolicy.scope.clear':
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
    case 'mode.create':
    case 'mode.update':
    case 'mode.delete':
    case 'conversation.mode.select':
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
