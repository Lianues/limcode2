import type { WorldReader } from '../ecs/types';
import type { StorageCapability } from '../capabilities/types';
import { ClientSyncStateKey } from '../world/clientSync/resources';
import type { ClientState, MessageRecord } from '../../shared/protocol';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

/**
 * ClientState 持久化协调器。
 * - Agent/Session/Link 等低频结构变化仍走 debounce 全量保存。
 * - Message CRUD 走 chunk 级增量保存。
 * - ToolCall 是高频状态对象，按 toolCallId 增量写 snapshot / event。
 */
export class ClientStatePersistence {
  private enabled = false;
  private lastPersistedGlobalJson = '';
  private pendingPersistGlobalJson = '';
  private pendingPersistState: ClientState | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly persistedMessageJson = new Map<string, string>();
  private readonly persistedMessageSession = new Map<string, string>();
  private readonly persistedToolCallJson = new Map<string, string>();
  private readonly persistedToolCallEventIds = new Set<string>();
  private incrementalPersistRunning = false;

  public constructor(
    private readonly world: WorldReader,
    private readonly storage: StorageCapability,
    private readonly debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS
  ) {}

  public enable(): void {
    this.enabled = true;
  }

  public rememberPersistedState(state: ClientState): void {
    this.lastPersistedGlobalJson = JSON.stringify(globalPersistenceSlice(state));
    this.rememberIncrementalState(state);
  }

  public queuePersist(): void {
    if (!this.enabled) return;

    const state = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    if (!state) return;

    this.queueIncrementalPersist(state);

    const globalJson = JSON.stringify(globalPersistenceSlice(state));
    if (globalJson === this.lastPersistedGlobalJson || globalJson === this.pendingPersistGlobalJson) return;

    this.pendingPersistGlobalJson = globalJson;
    this.pendingPersistState = state;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistImmediately(), this.debounceMs);
  }

  public persistImmediately(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    const latestState = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    const state = this.pendingPersistState ?? latestState;
    if (!this.enabled || !state) return;

    const globalJson = this.pendingPersistGlobalJson || JSON.stringify(globalPersistenceSlice(state));
    if (!globalJson || globalJson === this.lastPersistedGlobalJson) return;

    this.pendingPersistGlobalJson = '';
    this.pendingPersistState = undefined;
    void this.storage.saveClientState(state)
      .then(() => {
        this.lastPersistedGlobalJson = globalJson;
        this.rememberIncrementalState(state);
      })
      .catch((error) => console.warn('[LimCode] Failed to persist global client state:', error));
  }

  private queueIncrementalPersist(state: ClientState): void {
    if (this.incrementalPersistRunning) return;
    const tasks = this.collectIncrementalTasks(state);
    if (tasks.messages.length === 0 && tasks.toolSnapshots.length === 0 && tasks.toolEvents.length === 0) return;

    this.incrementalPersistRunning = true;
    void Promise.all(tasks.messages.map((task) => task()))
      .then(() => Promise.all(tasks.toolSnapshots.map((task) => task())))
      .then(() => Promise.all(tasks.toolEvents.map((task) => task())))
      .catch((error) => console.warn('[LimCode] Failed to persist incremental state:', error))
      .finally(() => {
        this.incrementalPersistRunning = false;
      });
  }

  private collectIncrementalTasks(state: ClientState): {
    messages: Array<() => Promise<void>>;
    toolSnapshots: Array<() => Promise<void>>;
    toolEvents: Array<() => Promise<void>>;
  } {
    const messages: Array<() => Promise<void>> = [];
    const toolSnapshots: Array<() => Promise<void>> = [];
    const toolEvents: Array<() => Promise<void>> = [];
    const currentMessages = new Map(state.messages.map((message) => [message.id, message]));
    const messageSession = new Map(state.messages.map((message) => [message.id, message.sessionId]));
    const toolCallsById = new Map(state.toolCalls.map((toolCall) => [toolCall.id, toolCall]));

    for (const message of state.messages) {
      const json = JSON.stringify(message);
      if (this.persistedMessageJson.get(message.id) === json) continue;
      messages.push(async () => {
        await this.storage.saveMessageSnapshot(message.sessionId, message);
        this.persistedMessageJson.set(message.id, json);
        this.persistedMessageSession.set(message.id, message.sessionId);
      });
    }

    for (const [messageId, sessionId] of this.persistedMessageSession) {
      if (currentMessages.has(messageId)) continue;
      messages.push(async () => {
        await this.storage.removeMessage(sessionId, messageId);
        this.persistedMessageJson.delete(messageId);
        this.persistedMessageSession.delete(messageId);
      });
    }

    for (const toolCall of state.toolCalls) {
      const sessionId = messageSession.get(toolCall.messageId);
      if (!sessionId) continue;
      const json = JSON.stringify(toolCall);
      if (this.persistedToolCallJson.get(toolCall.id) === json) continue;
      toolSnapshots.push(async () => {
        await this.storage.saveToolCallSnapshot(sessionId, toolCall);
        this.persistedToolCallJson.set(toolCall.id, json);
      });
    }

    for (const event of state.toolCallEvents ?? []) {
      if (this.persistedToolCallEventIds.has(event.id)) continue;
      const toolCall = toolCallsById.get(event.toolCallId);
      if (!toolCall) continue;
      const sessionId = messageSession.get(toolCall.messageId);
      if (!sessionId) continue;
      toolEvents.push(async () => {
        await this.storage.appendToolCallEvent(sessionId, event);
        this.persistedToolCallEventIds.add(event.id);
      });
    }

    return { messages, toolSnapshots, toolEvents };
  }

  private rememberIncrementalState(state: ClientState): void {
    this.persistedMessageJson.clear();
    this.persistedMessageSession.clear();
    for (const message of state.messages) {
      this.persistedMessageJson.set(message.id, JSON.stringify(message));
      this.persistedMessageSession.set(message.id, message.sessionId);
    }

    this.persistedToolCallJson.clear();
    for (const toolCall of state.toolCalls) {
      this.persistedToolCallJson.set(toolCall.id, JSON.stringify(toolCall));
    }

    this.persistedToolCallEventIds.clear();
    for (const event of state.toolCallEvents ?? []) {
      this.persistedToolCallEventIds.add(event.id);
    }
  }
}

function globalPersistenceSlice(state: ClientState): Pick<ClientState, 'agents' | 'sessions' | 'agentConversationLinks'> {
  return {
    agents: state.agents,
    sessions: state.sessions,
    agentConversationLinks: state.agentConversationLinks
  };
}
