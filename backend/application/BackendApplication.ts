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
import { Conversation, Message, PartOf } from '../world/modules/chat/components';
import type { ConversationData, MessageData } from '../world/modules/chat/components';
import { clientSyncPlugin, registerClientSyncSystems } from '../world/clientSync';
import { storageProjectionPlugin } from '../world/storageProjection';
import { EffectHandlerRegistry, registerApplicationEffectHandlers } from './effectHandlers';
import { flushEffects, flushEffectsWhere } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import { GLOBAL_SETTINGS_SECTIONS, createMessageId } from '../../shared/protocol';
import type {
  BridgeClientId,
  MessageContent,
  MsgStatus,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../shared/protocol';
import { createRuntimeEnv } from './createRuntimeEnv';
import { createDefaultAgentSpawnRequest, DEFAULT_AGENT_ID, DEFAULT_CONVERSATION_ID } from './defaults';
import { hydrateClientState } from './clientStateHydration';
import { ClientStatePersistence } from './ClientStatePersistence';
import { GlobalSettingsBridge } from './GlobalSettingsBridge';
import { ConversationSettingsBridge } from './ConversationSettingsBridge';
import { WebviewClientRegistry } from './WebviewClientRegistry';
import { WebviewMessageRouter } from './WebviewMessageRouter';

export interface SidebarConversationHistoryEntry {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  status: MsgStatus | 'empty';
  updatedAt?: number;
  agentName?: string;
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
    registerClientSyncSystems(this.scheduler);

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
      this.requestSnapshot(conversationId);
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

  /** 侧边栏只读投影：按最近消息时间排序的对话历史列表。 */
  public getConversationHistoryEntries(): SidebarConversationHistoryEntry[] {
    const messagesByConversation = this.collectMessagesByConversation();
    const agentNamesByConversation = this.collectAgentNamesByConversation();
    const entries: SidebarConversationHistoryEntry[] = [];

    for (const entity of this.world.query(Conversation)) {
      const conversation = this.world.get(entity, Conversation);
      if (!conversation?.id) continue;
      const messages = messagesByConversation.get(entity) ?? [];
      const latest = latestMessage(messages);
      const agentName = agentNamesByConversation.get(entity);
      const entry: SidebarConversationHistoryEntry = {
        id: conversation.id,
        title: conversationTitle(conversation, messages),
        preview: latest ? messagePreview(latest) : '暂无消息，点击开始新的交流。',
        messageCount: messages.length,
        status: latest?.status ?? 'empty'
      };
      if (latest) entry.updatedAt = latest.createdAt;
      if (agentName) entry.agentName = agentName;
      entries.push(entry);
    }

    return entries.filter((entry) => entry.title).sort(compareConversationHistoryEntries);
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
      this.flushPendingSnapshots();
      this.flushPendingHydrationMessages();
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        void this.globalSettingsBridge.postSnapshot(undefined, section);
      }
      this.resolveHydrated();
    }
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

  private findDefaultAgent(): Entity | undefined {
    return this.world.query(Agent).find((entity) => this.world.get(entity, Agent)?.id === DEFAULT_AGENT_ID)
      ?? this.world.query(Agent)[0];
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

function conversationTitle(conversation: ConversationData, messages: MessageData[]): string {
  const explicitTitle = normalizeText(conversation.title ?? '');
  if (explicitTitle && explicitTitle !== '新对话') return truncateText(explicitTitle, 28);

  const firstUserMessage = messages.find((message) => message.role === 'user');
  const titleFromMessage = firstUserMessage ? normalizeText(textPreview(firstUserMessage.content)) : '';
  if (titleFromMessage) return truncateText(titleFromMessage, 28);

  if (conversation.id === DEFAULT_CONVERSATION_ID) return '默认对话';
  return explicitTitle || '新对话';
}

function messagePreview(message: MessageData): string {
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

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
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
    case 'tool.execute':
    case 'agentRun.cancel':
    case 'agentRun.pause':
    case 'agentRun.resume':
    case 'agentRun.retry':
    case 'agentRun.regenerate':
    case 'agentRun.markStale':
      return true;
    default:
      return false;
  }
}
