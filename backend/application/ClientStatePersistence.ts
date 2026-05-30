import type { WorldReader } from '../ecs/types';
import type { StorageCapability } from '../capabilities/types';
import { ClientSyncStateKey } from '../world/clientSync/resources';
import type { ClientState } from '../../shared/protocol';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

/**
 * ClientState 持久化协调器。
 * 负责 debounce、重复状态去重、退出时立即 flush；不负责生成 ClientState。
 */
export class ClientStatePersistence {
  private enabled = false;
  private lastPersistedStateJson = '';
  private pendingPersistStateJson = '';
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

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
  }

  public queuePersist(): void {
    if (!this.enabled) return;

    const state = this.world.tryGetResource(ClientSyncStateKey)?.lastState;
    if (!state) return;

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
    void this.storage.saveClientState(JSON.parse(stateJson) as ClientState)
      .then(() => {
        this.lastPersistedStateJson = stateJson;
      })
      .catch((error) => console.warn('[LimCode] Failed to persist chat history:', error));
  }
}
