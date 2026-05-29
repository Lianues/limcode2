import * as vscode from 'vscode';
import { MapWorld } from '../ecs/World';
import { Scheduler } from '../ecs/Scheduler';
import { ChatEventType } from '../world/modules/chat/events';
import { ClientSyncEventType } from '../world/clientSync/events';
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
import { clientSyncPlugin } from '../world/clientSync';
import { createFakeLlmCapability, createVsCodeFsCapability, createWebviewCapability } from '../capabilities';
import { EffectHandlerRegistry, registerApplicationBindings } from './bindings';
import { flushEffects } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import { BridgeMessageType, type WebviewToExtensionMessage } from '../../shared/protocol';

/**
 * 后端应用组合根（composition root）。
 * 负责组装 World / RuntimeEnv / bindings / plugins，并把 VSCode shell 接入 ECS 世界。
 * 注意：这里不再内置任何默认 agent/session 占位数据；是否创建 agent 由调用方显式决定。
 */
export class BackendApplication {
  private readonly world = new MapWorld();
  private readonly outbox = new EffectOutbox();
  private readonly env: RuntimeEnv;
  private readonly scheduler: Scheduler;
  private readonly effectHandlers = new EffectHandlerRegistry();

  public constructor() {
    const registry = createToolRegistry();
    this.env = {
      llm: createFakeLlmCapability(),
      fs: createVsCodeFsCapability(),
      webview: createWebviewCapability(),
      tools: { registry: registry.list() }
    };

    registerApplicationBindings(this.effectHandlers);

    this.scheduler = new Scheduler(this.world, {
      applyEffect: (effect) => this.outbox.push(effect as WorldEffect),
      afterTick: () => flushEffects(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers)
    }, {
      parallelWorkers: true
    });

    installWorldPlugins(
      { world: this.world, scheduler: this.scheduler },
      [commonPlugin(), clientSyncPlugin(), agentPlugin(), toolsPlugin({ toolSchemas: registry.schemas() }), chatPlugin()]
    );
  }

  /** 由外部显式请求生成 agent，而不是在应用内部塞默认测试数据。 */
  public requestAgentSpawn(request: AgentSpawnRequestData): void {
    requestSpawnAgent(this.world, request);
  }

  public attachWebview(webview: vscode.Webview): void {
    this.env.webview.attach(webview);
    this.requestSnapshot();
  }

  public detachWebview(): void {
    this.env.webview.detach();
  }

  public handleWebviewMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case BridgeMessageType.ChatSend:
        this.world.enqueue({ type: ChatEventType.Send, payload: message.payload });
        break;
      case BridgeMessageType.ChatAbort:
        this.world.enqueue({ type: ChatEventType.Abort, payload: message.payload });
        break;
      case BridgeMessageType.ClientResync:
        this.requestSnapshot(message.payload?.sessionId);
        break;
      case BridgeMessageType.Ready:
        this.requestSnapshot();
        break;
      default:
        break;
    }
  }

  public dispose(): void {
    this.env.webview.detach();
  }

  private requestSnapshot(sessionId?: string): void {
    this.world.enqueue({ type: ClientSyncEventType.Resync, payload: sessionId ? { sessionId } : {} });
  }
}
