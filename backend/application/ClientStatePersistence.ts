import type { WorldReader } from '../ecs/types';
import type { StorageCapability } from '../capabilities/types';
import { ClientSyncStateKey } from '../world/clientSync/resources';
import type { ClientState } from '../../shared/protocol';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

export class ClientStatePersistence {
  private enabled = false;
  private lastPersistedGlobalJson = '';
  private pendingPersistGlobalJson = '';
  private pendingPersistState: ClientState | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly persistedMessageJson = new Map<string, string>();
  private readonly persistedMessageConversation = new Map<string, string>();
  private readonly persistedToolCallJson = new Map<string, string>();
  private readonly persistedToolCallEventIds = new Set<string>();
  private incrementalPersistRunning = false;
  private incrementalPersistDirty = false;

  public constructor(
    private readonly world: WorldReader,
    private readonly storage: StorageCapability,
    private readonly debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS
  ) {}

  public enable(): void { this.enabled = true; }

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
    this.persistTimer = setTimeout(() => { void this.persistImmediately(); }, this.debounceMs);
  }

  public async persistImmediately(options: { force?: boolean; throwOnError?: boolean } = {}): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    const latestState = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    const state = options.force ? (latestState ?? this.pendingPersistState) : (this.pendingPersistState ?? latestState);
    if (!this.enabled || !state) return;

    const globalJson = options.force ? JSON.stringify(globalPersistenceSlice(state)) : (this.pendingPersistGlobalJson || JSON.stringify(globalPersistenceSlice(state)));
    if (!globalJson || (!options.force && globalJson === this.lastPersistedGlobalJson)) return;

    this.pendingPersistGlobalJson = '';
    this.pendingPersistState = undefined;
    try {
      await this.storage.saveClientState(state);
      this.lastPersistedGlobalJson = globalJson;
      this.rememberIncrementalState(state);
    } catch (error) {
      console.warn('[LimCode] Failed to persist global client state:', error);
      if (options.throwOnError) throw error;
    }
  }

  private queueIncrementalPersist(state: ClientState): void {
    if (this.incrementalPersistRunning) {
      this.incrementalPersistDirty = true;
      return;
    }
    const tasks = this.collectIncrementalTasks(state);
    if (tasks.messages.length === 0 && tasks.toolSnapshots.length === 0 && tasks.toolEvents.length === 0) return;

    this.incrementalPersistRunning = true;
    void runSequentially(tasks.messages)
      .then(() => runSequentially(tasks.toolSnapshots))
      .then(() => runSequentially(tasks.toolEvents))
      .catch((error) => console.warn('[LimCode] Failed to persist incremental state:', error))
      .finally(() => {
        this.incrementalPersistRunning = false;
        if (this.incrementalPersistDirty) {
          this.incrementalPersistDirty = false;
          const latestState = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
          if (latestState) this.queueIncrementalPersist(latestState);
        }
      });
  }

  private collectIncrementalTasks(state: ClientState): { messages: Array<() => Promise<void>>; toolSnapshots: Array<() => Promise<void>>; toolEvents: Array<() => Promise<void>> } {
    const messages: Array<() => Promise<void>> = [];
    const toolSnapshots: Array<() => Promise<void>> = [];
    const toolEvents: Array<() => Promise<void>> = [];
    const currentMessages = new Map(state.messages.map((message) => [message.id, message]));
    const messageConversation = new Map(state.messages.map((message) => [message.id, message.conversationId]));
    const toolCallsById = new Map(state.toolCalls.map((toolCall) => [toolCall.id, toolCall]));

    for (const message of state.messages) {
      const conversationId = message.conversationId;
      const json = JSON.stringify(message);
      if (this.persistedMessageJson.get(message.id) === json) continue;
      messages.push(async () => {
        await this.storage.saveMessageSnapshot(conversationId, message);
        this.persistedMessageJson.set(message.id, json);
        this.persistedMessageConversation.set(message.id, conversationId);
      });
    }

    for (const [messageId, conversationId] of this.persistedMessageConversation) {
      if (currentMessages.has(messageId)) continue;
      messages.push(async () => {
        await this.storage.removeMessage(conversationId, messageId);
        this.persistedMessageJson.delete(messageId);
        this.persistedMessageConversation.delete(messageId);
      });
    }

    for (const toolCall of state.toolCalls) {
      const conversationId = messageConversation.get(toolCall.messageId);
      if (!conversationId) continue;
      const json = JSON.stringify(toolCall);
      if (this.persistedToolCallJson.get(toolCall.id) === json) continue;
      toolSnapshots.push(async () => {
        await this.storage.saveToolCallSnapshot(conversationId, toolCall);
        this.persistedToolCallJson.set(toolCall.id, json);
      });
    }

    for (const event of state.toolCallEvents ?? []) {
      if (this.persistedToolCallEventIds.has(event.id)) continue;
      const toolCall = toolCallsById.get(event.toolCallId);
      if (!toolCall) continue;
      const conversationId = messageConversation.get(toolCall.messageId);
      if (!conversationId) continue;
      toolEvents.push(async () => {
        await this.storage.appendToolCallEvent(conversationId, event);
        this.persistedToolCallEventIds.add(event.id);
      });
    }

    return { messages, toolSnapshots, toolEvents };
  }

  private rememberIncrementalState(state: ClientState): void {
    this.persistedMessageJson.clear();
    this.persistedMessageConversation.clear();
    for (const message of state.messages) {
      const conversationId = message.conversationId;
      this.persistedMessageJson.set(message.id, JSON.stringify(message));
      this.persistedMessageConversation.set(message.id, conversationId);
    }

    this.persistedToolCallJson.clear();
    for (const toolCall of state.toolCalls) this.persistedToolCallJson.set(toolCall.id, JSON.stringify(toolCall));

    this.persistedToolCallEventIds.clear();
    for (const event of state.toolCallEvents ?? []) this.persistedToolCallEventIds.add(event.id);
  }
}

function globalPersistenceSlice(state: ClientState): ClientState {
  return { ...state, messages: [], toolCalls: [], toolCallEvents: [] };
}

async function runSequentially(tasks: Array<() => Promise<void>>): Promise<void> {
  for (const task of tasks) await task();
}
