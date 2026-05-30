import type { WorldReader } from '../ecs/types';
import type { StorageCapability } from '../capabilities/types';
import { ClientSyncStateKey } from '../world/clientSync/resources';
import type { ClientState, ToolCallEventRecord, ToolCallRecord } from '../../shared/protocol';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

/**
 * ClientState 持久化协调器。
 * - 普通 client state 仍走 debounce 全量保存。
 * - ToolCall 是高频状态对象：额外按 toolCallId 增量写 snapshot / event。
 */
export class ClientStatePersistence {
  private enabled = false;
  private lastPersistedStateJson = '';
  private pendingPersistStateJson = '';
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.lastPersistedStateJson = JSON.stringify(state);
    this.rememberToolCallState(state);
  }

  public queuePersist(): void {
    if (!this.enabled) return;

    const state = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    if (!state) return;

    this.queueIncrementalToolCallPersist(state);

    const stateJson = JSON.stringify(state);
    if (stateJson === this.lastPersistedStateJson || stateJson === this.pendingPersistStateJson) return;

    this.pendingPersistStateJson = stateJson;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistImmediately(), this.debounceMs);
  }

  public persistImmediately(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    const latestState = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    const stateJson = this.pendingPersistStateJson || (latestState ? JSON.stringify(latestState) : '');
    if (!this.enabled || !stateJson || stateJson === this.lastPersistedStateJson) return;

    this.pendingPersistStateJson = '';
    const state = JSON.parse(stateJson) as ClientState;
    void this.storage.saveClientState(state)
      .then(() => {
        this.lastPersistedStateJson = stateJson;
        this.rememberToolCallState(state);
      })
      .catch((error) => console.warn('[LimCode] Failed to persist chat history:', error));
  }

  private queueIncrementalToolCallPersist(state: ClientState): void {
    if (this.incrementalPersistRunning) return;
    const tasks = this.collectIncrementalToolCallTasks(state);
    if (tasks.snapshots.length === 0 && tasks.events.length === 0) return;

    this.incrementalPersistRunning = true;
    void Promise.all(tasks.snapshots.map((task) => task()))
      .then(() => Promise.all(tasks.events.map((task) => task())))
      .catch((error) => console.warn('[LimCode] Failed to persist incremental tool call state:', error))
      .finally(() => {
        this.incrementalPersistRunning = false;
      });
  }

  private collectIncrementalToolCallTasks(state: ClientState): { snapshots: Array<() => Promise<void>>; events: Array<() => Promise<void>> } {
    const snapshots: Array<() => Promise<void>> = [];
    const events: Array<() => Promise<void>> = [];
    const messageSession = new Map(state.messages.map((message) => [message.id, message.sessionId]));
    const toolCallsById = new Map(state.toolCalls.map((toolCall) => [toolCall.id, toolCall]));

    for (const toolCall of state.toolCalls) {
      const sessionId = messageSession.get(toolCall.messageId);
      if (!sessionId) continue;
      const json = JSON.stringify(toolCall);
      if (this.persistedToolCallJson.get(toolCall.id) === json) continue;
      snapshots.push(async () => {
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
      events.push(async () => {
        await this.storage.appendToolCallEvent(sessionId, event);
        this.persistedToolCallEventIds.add(event.id);
      });
    }

    return { snapshots, events };
  }

  private rememberToolCallState(state: ClientState): void {
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
