import * as vscode from 'vscode';
import { MapWorld } from '../ecs/World';
import { Scheduler } from '../ecs/Scheduler';
import type { Entity } from '../ecs/types';
import { ChatEventType } from '../world/modules/chat/events';
import { ClientSyncEventType } from '../world/clientSync/events';
import { ClientSyncStateKey } from '../world/clientSync/resources';
import { EffectOutbox, type WorldEffect } from '../world/effects';
import { installWorldPlugins } from '../world/plugin';
import {
  agentPlugin,
  chatPlugin,
  commonPlugin,
  createToolRegistry,
  requestSpawnAgent,
  toolsPlugin
} from '../world/modules';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ModelProfile,
  ParentAgent,
  SystemPrompt,
  ToolPolicy,
  type ModelProfileData,
  type ToolPolicyData
} from '../world/modules/agent/components';
import { Message, PartOf, Session } from '../world/modules/chat/components';
import { clientSyncPlugin } from '../world/clientSync';
import {
  createLlmProviderCapability,
  createVsCodeFsCapability,
  createVsCodeStorageCapability,
  createWebviewCapability,
  DEFAULT_LLM_MODEL
} from '../capabilities';
import { EffectHandlerRegistry, registerApplicationBindings } from './bindings';
import { flushEffects, flushEffectsWhere } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import { BridgeMessageType, type AgentConversationLinkRecord, type AgentRecord, type ClientState, type LlmSettingsUpdatePayload, type MessageRecord, type WebviewToExtensionMessage } from '../../shared/protocol';

const DEFAULT_AGENT_ID = 'main';
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_AGENT_NAME = 'LimCode Agent';
const PERSIST_DEBOUNCE_MS = 500;

/**
 * 后端应用组合根（composition root）。
 * 负责组装 World / RuntimeEnv / bindings / plugins，并把 VSCode shell 接入 ECS 世界。
 */
export class BackendApplication {
  private readonly world = new MapWorld();
  private readonly outbox = new EffectOutbox();
  private readonly env: RuntimeEnv;
  private readonly scheduler: Scheduler;
  private readonly effectHandlers = new EffectHandlerRegistry();
  private hydrated = false;
  private lastPersistedStateJson = '';
  private pendingPersistStateJson = '';
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    const registry = createToolRegistry();
    const storage = createVsCodeStorageCapability(context);

    this.env = {
      llm: createLlmProviderCapability({
        settings: () => storage.loadLlmSettings()
      }),
      fs: createVsCodeFsCapability(),
      webview: createWebviewCapability(),
      storage,
      paths: storage.paths,
      tools: { registry: registry.list() }
    };

    registerApplicationBindings(this.effectHandlers);

    this.scheduler = new Scheduler(this.world, {
      applyEffect: (effect) => this.outbox.push(effect as WorldEffect),
      afterPass: () => {
        flushEffectsWhere(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers, isRealtimeClientEffect);
      },
      afterTick: () => {
        flushEffects(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers);
        this.queuePersistClientState();
      }
    }, {
      parallelWorkers: true
    });

    installWorldPlugins(
      { world: this.world, scheduler: this.scheduler },
      [commonPlugin(), clientSyncPlugin(), agentPlugin(), toolsPlugin({ toolSchemas: registry.schemas() }), chatPlugin()]
    );

    void this.initializeClientState();
  }

  /** 由外部显式请求生成 agent；基础对话会在初始化时创建 main/default。 */
  public requestAgentSpawn(request: AgentSpawnRequestData): void {
    requestSpawnAgent(this.world, request);
  }

  public attachWebview(webview: vscode.Webview): void {
    this.env.webview.attach(webview);
    if (this.hydrated) {
      this.requestSnapshot();
      void this.postLlmSettings();
    }
  }

  public detachWebview(): void {
    this.env.webview.detach();
  }

  public handleWebviewMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case BridgeMessageType.ChatSend:
        if (!this.hydrated) return;
        this.world.enqueue({ type: ChatEventType.Send, payload: message.payload });
        break;
      case BridgeMessageType.ChatAbort:
        if (!this.hydrated) return;
        this.world.enqueue({ type: ChatEventType.Abort, payload: message.payload });
        break;
      case BridgeMessageType.ClientResync:
        if (this.hydrated) this.requestSnapshot(message.payload?.sessionId);
        break;
      case BridgeMessageType.LlmSettingsGet:
        void this.postLlmSettings();
        break;
      case BridgeMessageType.LlmSettingsUpdate:
        void this.updateLlmSettings(message.payload);
        break;
      case BridgeMessageType.Ready:
        if (this.hydrated) {
          this.requestSnapshot();
          void this.postLlmSettings();
        }
        break;
      default:
        break;
    }
  }

  public dispose(): void {
    this.env.webview.detach();
    this.persistImmediately();
  }

  private async initializeClientState(): Promise<void> {
    try {
      await this.env.storage.ensureReady();
      const restored = await this.env.storage.loadClientState();
      if (restored && this.hydrateClientState(restored)) {
        this.lastPersistedStateJson = JSON.stringify(restored);
      } else {
        this.spawnDefaultAgent();
      }
      console.log(`[LimCode] Storage roots: agents=${this.env.paths.agentsRootPath}, conversations=${this.env.paths.conversationsRootPath}, links=${this.env.paths.linksRootPath}`);
    } catch (error) {
      console.warn('[LimCode] Failed to initialize stored chat state. Starting with a fresh session.', error);
      this.spawnDefaultAgent();
    } finally {
      this.hydrated = true;
      this.requestSnapshot();
      void this.postLlmSettings();
    }
  }

  private spawnDefaultAgent(): void {
    this.requestAgentSpawn({
      kind: 'main',
      agentId: DEFAULT_AGENT_ID,
      agentName: DEFAULT_AGENT_NAME,
      sessionId: DEFAULT_SESSION_ID
    });
  }

  private hydrateClientState(state: ClientState): boolean {
    const hasAnyState = state.agents.length > 0 || state.sessions.length > 0 || state.messages.length > 0;
    if (!hasAnyState) return false;

    const agents = state.agents.length > 0 ? state.agents : [createDefaultAgentRecord()];
    const sessions = state.sessions.length > 0
      ? state.sessions
      : [{ id: DEFAULT_SESSION_ID }];

    const agentEntities = new Map<string, Entity>();
    for (const agent of agents) {
      const entity = this.world.spawn();
      agentEntities.set(agent.id, entity);
      this.world.add(entity, Agent, { id: agent.id, name: agent.name || DEFAULT_AGENT_NAME });
      this.world.add(entity, AgentKind, { kind: agent.kind || 'main' });
      this.world.add(entity, AgentStatus, { status: agent.status ?? 'idle' });
      this.world.add(entity, ModelProfile, normalizeModelProfile(agent.model));
      this.world.add(entity, ToolPolicy, normalizeToolPolicy(agent.toolPolicy));
      this.world.add(entity, SystemPrompt, { text: agent.systemPrompt || createDefaultAgentRecord().systemPrompt || '' });
    }

    for (const agent of agents) {
      if (!agent.parentAgentId) continue;
      const entity = agentEntities.get(agent.id);
      const parent = agentEntities.get(agent.parentAgentId);
      if (entity !== undefined && parent !== undefined) {
        this.world.add(entity, ParentAgent, { parent });
      }
    }

    const sessionEntities = new Map<string, Entity>();
    for (const session of sessions) {
      const entity = this.world.spawn();
      sessionEntities.set(session.id, entity);
      this.world.add(entity, Session, { id: session.id });
    }

    for (const link of state.agentConversationLinks) {
      this.spawnHydratedAgentConversationLink(agentEntities, sessionEntities, link);
    }

    for (const record of state.messages) {
      const sessionEntity = sessionEntities.get(record.sessionId);
      if (sessionEntity === undefined) continue;
      this.spawnHydratedMessage(sessionEntity, record);
    }

    return true;
  }

  private spawnHydratedMessage(session: Entity, record: MessageRecord): void {
    const entity = this.world.spawn();
    this.world.add(entity, Message, {
      id: record.id,
      role: record.role,
      text: record.text,
      status: record.status === 'streaming' ? 'error' : record.status,
      seq: record.seq,
      createdAt: Date.now()
    });
    this.world.add(entity, PartOf, { parent: session });
  }

  private spawnHydratedAgentConversationLink(
    agents: Map<string, Entity>,
    sessions: Map<string, Entity>,
    record: AgentConversationLinkRecord
  ): void {
    const agent = agents.get(record.agentId);
    const conversation = sessions.get(record.sessionId);
    if (agent === undefined || conversation === undefined) return;

    const entity = this.world.spawn();
    const now = Date.now();
    this.world.add(entity, AgentConversationLink, {
      id: record.id,
      agent,
      conversation,
      role: record.role,
      createdAt: now,
      updatedAt: now
    });
  }

  private requestSnapshot(sessionId?: string): void {
    this.world.enqueue({ type: ClientSyncEventType.Resync, payload: sessionId ? { sessionId } : {} });
  }

  private async postLlmSettings(): Promise<void> {
    const settings = await this.env.storage.loadLlmSettings();
    this.env.webview.post({
      type: BridgeMessageType.LlmSettingsSnapshot,
      payload: {
        settings,
        filePath: this.env.paths.llmSettingsPath
      }
    });
  }

  private async updateLlmSettings(payload: LlmSettingsUpdatePayload | undefined): Promise<void> {
    if (!payload) return;
    const settings = await this.env.storage.saveLlmSettings(payload.settings);
    this.env.webview.post({
      type: BridgeMessageType.LlmSettingsSnapshot,
      payload: {
        settings,
        filePath: this.env.paths.llmSettingsPath
      }
    });
  }

  private queuePersistClientState(): void {
    if (!this.hydrated) return;

    const state = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    if (!state) return;

    const stateJson = JSON.stringify(state);
    if (stateJson === this.lastPersistedStateJson || stateJson === this.pendingPersistStateJson) return;

    this.pendingPersistStateJson = stateJson;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistImmediately(), PERSIST_DEBOUNCE_MS);
  }

  private persistImmediately(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    const latestState = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    const stateJson = this.pendingPersistStateJson || (latestState ? JSON.stringify(latestState) : '');
    if (!this.hydrated || !stateJson || stateJson === this.lastPersistedStateJson) return;

    this.pendingPersistStateJson = '';
    void this.env.storage.saveClientState(JSON.parse(stateJson) as ClientState)
      .then(() => {
        this.lastPersistedStateJson = stateJson;
      })
      .catch((error) => console.warn('[LimCode] Failed to persist chat history:', error));
  }
}

function createDefaultAgentRecord(): AgentRecord {
  return {
    id: DEFAULT_AGENT_ID,
    name: DEFAULT_AGENT_NAME,
    kind: 'main',
    status: 'idle',
    model: { provider: 'deepseek', model: DEFAULT_LLM_MODEL, temperature: 0.2 },
    toolPolicy: { allowedTools: [], approvalMode: 'never' },
    systemPrompt: 'You are LimCode, a concise and helpful AI coding assistant running inside VS Code. Reply in the user\'s language unless asked otherwise.'
  };
}

function normalizeModelProfile(model: AgentRecord['model']): ModelProfileData {
  return {
    provider: isKnownLlmProvider(model?.provider) ? model.provider : 'deepseek',
    model: model?.model || DEFAULT_LLM_MODEL,
    temperature: model?.temperature
  };
}

function normalizeToolPolicy(toolPolicy: AgentRecord['toolPolicy']): ToolPolicyData {
  const approvalMode = toolPolicy?.approvalMode === 'always' || toolPolicy?.approvalMode === 'onRisk' || toolPolicy?.approvalMode === 'never'
    ? toolPolicy.approvalMode
    : 'never';
  return {
    allowedTools: Array.isArray(toolPolicy?.allowedTools) ? toolPolicy.allowedTools : [],
    approvalMode
  };
}

function isKnownLlmProvider(provider: string | undefined): provider is ModelProfileData['provider'] {
  return provider === 'deepseek' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini';
}

function isRealtimeClientEffect(effect: WorldEffect): boolean {
  const kind = (effect as { kind?: string }).kind;
  return kind === 'client.patch' || kind === 'client.snapshot';
}
