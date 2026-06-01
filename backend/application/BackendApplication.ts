import * as vscode from 'vscode';
import { MapWorld } from '../ecs/World';
import { Scheduler } from '../ecs/Scheduler';
import type { Entity } from '../ecs/types';
import { ClientSyncEventType } from '../world/clientSync/events';
import { EffectOutbox, type WorldEffect } from '../world/effects';
import { installWorldPlugins } from '../world/plugin';
import {
  agentPlugin,
  chatPlugin,
  commonPlugin,
  modePlugin,
  agentRunPlugin,
  requestSpawnAgent,
  toolsPlugin
} from '../world/modules';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import { Agent, AgentConversationLink } from '../world/modules/agent/components';
import { Conversation } from '../world/modules/chat/components';
import { clientSyncPlugin } from '../world/clientSync';
import { storageProjectionPlugin } from '../world/storageProjection';
import { EffectHandlerRegistry, registerApplicationEffectHandlers } from './effectHandlers';
import { flushEffects, flushEffectsWhere } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import { GLOBAL_SETTINGS_SECTIONS, createMessageId } from '../../shared/protocol';
import type {
  BridgeClientId,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../shared/protocol';
import { createRuntimeEnv } from './createRuntimeEnv';
import { createDefaultAgentSpawnRequest, DEFAULT_AGENT_ID } from './defaults';
import { hydrateClientState } from './clientStateHydration';
import { ClientStatePersistence } from './ClientStatePersistence';
import { GlobalSettingsBridge } from './GlobalSettingsBridge';
import { ConversationSettingsBridge } from './ConversationSettingsBridge';
import { WebviewClientRegistry } from './WebviewClientRegistry';
import { WebviewMessageRouter } from './WebviewMessageRouter';

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

  public constructor(context: vscode.ExtensionContext) {
    const { env, toolSchemas } = createRuntimeEnv(context);
    this.env = env;
    this.persistence = new ClientStatePersistence(this.world, this.env.storage);
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
      globalSettingsBridge: this.globalSettingsBridge,
      conversationSettingsBridge: this.conversationSettingsBridge,
      isHydrated: () => this.hydrated,
      requestSnapshot: (conversationId) => this.requestSnapshot(conversationId)
    });

    registerApplicationEffectHandlers(this.effectHandlers);

    this.scheduler = new Scheduler(this.world, {
      applyEffect: (effect) => this.outbox.push(effect as WorldEffect),
      afterPass: () => {
        flushEffectsWhere(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers, isRealtimeClientEffect);
      },
      afterTick: () => {
        flushEffects(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers);
        this.persistence.queuePersist();
      }
    }, {
      parallelWorkers: true
    });

    installWorldPlugins(
      { world: this.world, scheduler: this.scheduler },
      [commonPlugin(), clientSyncPlugin(), storageProjectionPlugin(), agentPlugin(), modePlugin(), toolsPlugin({ toolSchemas }), chatPlugin(), agentRunPlugin()]
    );

    void this.initializeClientState();
  }

  /** 由外部显式请求生成 agent；基础对话会在初始化时创建 main/default。 */
  public requestAgentSpawn(request: AgentSpawnRequestData): void {
    requestSpawnAgent(this.world, request);
  }

  /** 创建一个独立 conversation，并用独立 AgentConversationLink 绑定到默认 agent。 */
  public createConversation(): string {
    const conversationId = `conversation-${createMessageId()}`;
    const title = '新对话';
    const agent = this.findDefaultAgent();
    if (agent === undefined) {
      requestSpawnAgent(this.world, { ...createDefaultAgentSpawnRequest(), conversationId, initialMessage: undefined });
      return conversationId;
    }

    const conversation = this.world.spawn();
    this.world.add(conversation, Conversation, { id: conversationId, title, visibility: 'visible' });

    const link = this.world.spawn();
    const now = Date.now();
    this.world.add(link, AgentConversationLink, {
      id: `acl${link}`,
      agent,
      conversation,
      role: 'default',
      createdAt: now,
      updatedAt: now
    });

    this.requestSnapshot();
    return conversationId;
  }

  /** 当前 active data root；可能是 VS Code 默认 globalStorageUri，也可能是用户配置的自定义目录。 */
  public getStorageRootUri(): vscode.Uri {
    return this.env.storage.paths.globalStorageUri;
  }

  public attachWebview(webview: vscode.Webview, meta: WebviewClientMeta = { kind: 'unknown' }): BridgeClientId {
    const clientId = this.env.webview.attach(webview, meta);
    this.webviewClients.register(clientId, meta);
    return clientId;
  }

  public detachWebview(clientId: BridgeClientId): void {
    this.env.webview.detach(clientId);
    this.webviewClients.unregister(clientId);
  }

  public handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    this.webviewRouter.handle(clientId, message);
  }

  public dispose(): void {
    this.env.webview.detachAll();
    this.webviewClients.clear();
    void this.persistence.persistImmediately();
  }

  private async initializeClientState(): Promise<void> {
    try {
      await this.env.storage.ensureReady();
      const restored = await this.env.storage.loadClientState();
      if (restored && hydrateClientState(this.world, restored)) {
        this.persistence.rememberPersistedState(restored);
      } else {
        requestSpawnAgent(this.world, createDefaultAgentSpawnRequest());
      }
      const paths = this.env.storage.paths;
      console.log(`[LimCode] Data root: ${paths.globalStoragePath}`);
      console.log(`[LimCode] Storage roots: agents=${paths.agentsRootPath}, conversations=${paths.conversationsRootPath}, links=${paths.linksRootPath}`);
    } catch (error) {
      console.warn('[LimCode] Failed to initialize stored chat state. Starting with a fresh conversation.', error);
      requestSpawnAgent(this.world, createDefaultAgentSpawnRequest());
    } finally {
      this.hydrated = true;
      this.persistence.enable();
      this.requestSnapshot();
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        void this.globalSettingsBridge.postSnapshot(undefined, section);
      }
    }
  }

  private requestSnapshot(conversationId?: string): void {
    this.world.enqueue({ type: ClientSyncEventType.Resync, payload: conversationId ? { conversationId } : {} });
  }

  private findDefaultAgent(): Entity | undefined {
    return this.world.query(Agent).find((entity) => this.world.get(entity, Agent)?.id === DEFAULT_AGENT_ID)
      ?? this.world.query(Agent)[0];
  }
}

function isRealtimeClientEffect(effect: WorldEffect): boolean {
  const kind = (effect as { kind?: string }).kind;
  return kind === 'client.patch' || kind === 'client.snapshot';
}
