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
  requestSpawnAgent,
  toolsPlugin
} from '../world/modules';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import { Agent, AgentConversationLink } from '../world/modules/agent/components';
import { Session } from '../world/modules/chat/components';
import { clientSyncPlugin } from '../world/clientSync';
import { EffectHandlerRegistry, registerApplicationEffectHandlers } from './effectHandlers';
import { flushEffects, flushEffectsWhere } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import { createMessageId } from '../../shared/protocol';
import type {
  BridgeClientId,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../shared/protocol';
import { createRuntimeEnv } from './createRuntimeEnv';
import { createDefaultAgentSpawnRequest, DEFAULT_AGENT_ID } from './defaults';
import { hydrateClientState } from './clientStateHydration';
import { ClientStatePersistence } from './ClientStatePersistence';
import { LlmSettingsBridge } from './LlmSettingsBridge';
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
  private readonly settingsBridge: LlmSettingsBridge;
  private readonly webviewClients = new WebviewClientRegistry();
  private readonly webviewRouter: WebviewMessageRouter;
  private hydrated = false;

  public constructor(context: vscode.ExtensionContext) {
    const { env, toolSchemas } = createRuntimeEnv(context);
    this.env = env;
    this.persistence = new ClientStatePersistence(this.world, this.env.storage);
    this.settingsBridge = new LlmSettingsBridge({
      storage: this.env.storage,
      webview: this.env.webview,
      paths: this.env.paths
    });
    this.webviewRouter = new WebviewMessageRouter({
      world: this.world,
      webview: this.env.webview,
      clients: this.webviewClients,
      settingsBridge: this.settingsBridge,
      isHydrated: () => this.hydrated,
      requestSnapshot: (sessionId) => this.requestSnapshot(sessionId)
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
      [commonPlugin(), clientSyncPlugin(), agentPlugin(), toolsPlugin({ toolSchemas }), chatPlugin()]
    );

    void this.initializeClientState();
  }

  /** 由外部显式请求生成 agent；基础对话会在初始化时创建 main/default。 */
  public requestAgentSpawn(request: AgentSpawnRequestData): void {
    requestSpawnAgent(this.world, request);
  }

  /** 创建一个独立 conversation，并用独立 AgentConversationLink 绑定到默认 agent。 */
  public createConversation(): string {
    const sessionId = `conversation-${createMessageId()}`;
    const agent = this.findDefaultAgent();
    if (agent === undefined) {
      requestSpawnAgent(this.world, { ...createDefaultAgentSpawnRequest(), sessionId });
      return sessionId;
    }

    const session = this.world.spawn();
    this.world.add(session, Session, { id: sessionId });

    const link = this.world.spawn();
    const now = Date.now();
    this.world.add(link, AgentConversationLink, {
      id: `acl${link}`,
      agent,
      conversation: session,
      role: 'active',
      createdAt: now,
      updatedAt: now
    });

    this.requestSnapshot();
    return sessionId;
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
    this.persistence.persistImmediately();
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
      console.log(`[LimCode] Storage roots: agents=${this.env.paths.agentsRootPath}, conversations=${this.env.paths.conversationsRootPath}, links=${this.env.paths.linksRootPath}`);
    } catch (error) {
      console.warn('[LimCode] Failed to initialize stored chat state. Starting with a fresh session.', error);
      requestSpawnAgent(this.world, createDefaultAgentSpawnRequest());
    } finally {
      this.hydrated = true;
      this.persistence.enable();
      this.requestSnapshot();
      void this.settingsBridge.postSnapshot();
    }
  }

  private requestSnapshot(sessionId?: string): void {
    this.world.enqueue({ type: ClientSyncEventType.Resync, payload: sessionId ? { sessionId } : {} });
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
