import type { GlobalSettingsStoreResult, StorageCapability, WebviewCapability } from '../capabilities/types';
import { isSettingsRevisionConflictError } from '../capabilities/settingsRevisionConflict';
import {
  BridgeMessageType,
  GLOBAL_SETTINGS_SECTIONS,
  globalSettingsStreamId,
  createMessageId,
  type BridgeClientId,
  type ExtensionToWebviewMessage,
  type GlobalSettingsSection,
  type GlobalSettingsUpdatePayload
} from '../../shared/protocol';

export interface GlobalSettingsCommitEvent {
  request: GlobalSettingsUpdatePayload;
  stored: GlobalSettingsStoreResult;
}

export interface GlobalSettingsBridgeDeps {
  storage: StorageCapability;
  webview: WebviewCapability;
  /** common 提交前始终 flush 当前 data root；是否真的切 root 由存储事务返回。 */
  beforeCommonCommit?: () => Promise<void>;
  /** 已提交后的领域副作用。失败只能告警，不能把已落盘设置伪装成保存失败。 */
  afterCommit?: (event: GlobalSettingsCommitEvent) => Promise<void> | void;
}

/**
 * 全局设置桥接：负责 request/ack 的 client 归属、CAS 冲突刷新与 committed snapshot 广播。
 * 存储提交和运行时副作用是两个清晰边界；后者失败不会回滚或否认前者。
 */
export class GlobalSettingsBridge {
  public constructor(private readonly deps: GlobalSettingsBridgeDeps) {}

  public async postSnapshot(clientId: BridgeClientId | undefined, section: GlobalSettingsSection, correlationId?: string): Promise<void> {
    const streamId = globalSettingsStreamId(section);
    if (clientId) this.deps.webview.subscribe(clientId, streamId);

    try {
      const stored = await this.deps.storage.loadGlobalSettings(section);
      const message = this.createSnapshotMessage(stored, correlationId);
      if (clientId) this.deps.webview.post(clientId, message);
      else this.deps.webview.broadcastToStream(streamId, message);
    } catch (error) {
      console.warn('[LimCode] Failed to load global settings:', error);
      this.postSettingsError(BridgeMessageType.GlobalSettingsGet, section, error, correlationId, clientId);
    }
  }

  public async update(
    payload: GlobalSettingsUpdatePayload | undefined,
    correlationId?: string,
    requesterClientId?: BridgeClientId
  ): Promise<void> {
    if (!payload) return;

    let stored: GlobalSettingsStoreResult;
    try {
      // common 可能迁移并清理当前 data root。无论最后是否实际切换，都先保证内存数据已提交。
      if (payload.section === 'common') await this.deps.beforeCommonCommit?.();
      stored = await this.deps.storage.saveGlobalSettings(payload.section, payload.settings, payload.expectedRevision);
    } catch (error) {
      console.warn('[LimCode] Failed to update global settings:', error);
      if (isSettingsRevisionConflictError(error)) {
        await this.publishLatestAfterConflict(payload.section, requesterClientId);
      }
      this.postSettingsError(
        BridgeMessageType.GlobalSettingsUpdate,
        payload.section,
        error,
        correlationId,
        requesterClientId
      );
      return;
    }

    // 只有请求者收到 correlated ack；其它订阅者只收到无 correlation 的 external snapshot。
    this.publishCommittedSnapshot(stored, correlationId, requesterClientId);

    // 先让 ack 离开提交路径，再启动领域副作用。async handler 会同步执行到首个 await，
    // 因而 common handler 可以立即触发 watcher 重绑，同时任何后续失败都只记录告警。
    this.startAfterCommit({ request: payload, stored });

    if (stored.dataRootChanged) {
      await this.broadcastSnapshotsAfterDataRootChange();
    }
  }

  private publishCommittedSnapshot(
    stored: GlobalSettingsStoreResult,
    correlationId: string | undefined,
    requesterClientId: BridgeClientId | undefined
  ): void {
    const streamId = globalSettingsStreamId(stored.section);
    if (requesterClientId) {
      this.deps.webview.post(requesterClientId, this.createSnapshotMessage(stored, correlationId));
    }
    this.deps.webview.broadcastToStream(
      streamId,
      this.createSnapshotMessage(stored),
      requesterClientId ? { excludeClientIds: [requesterClientId] } : undefined
    );
  }

  private async publishLatestAfterConflict(
    section: GlobalSettingsSection,
    requesterClientId: BridgeClientId | undefined
  ): Promise<void> {
    try {
      const latest = await this.deps.storage.loadGlobalSettings(section);
      const streamId = globalSettingsStreamId(section);
      const message = this.createSnapshotMessage(latest);
      if (requesterClientId) this.deps.webview.post(requesterClientId, message);
      this.deps.webview.broadcastToStream(
        streamId,
        message,
        requesterClientId ? { excludeClientIds: [requesterClientId] } : undefined
      );
    } catch (snapshotError) {
      console.warn('[LimCode] Failed to refresh global settings after revision conflict:', snapshotError);
    }
  }

  private async broadcastSnapshotsAfterDataRootChange(): Promise<void> {
    for (const section of GLOBAL_SETTINGS_SECTIONS) {
      if (section === 'common') continue;
      try {
        const stored = await this.deps.storage.loadGlobalSettings(section);
        this.deps.webview.broadcastToStream(
          globalSettingsStreamId(section),
          this.createSnapshotMessage(stored)
        );
      } catch (error) {
        // common 已经 committed；新 root 的某个 section 读取失败不能反向伪装成 common 保存失败。
        console.warn(`[LimCode] Failed to broadcast ${section} after data-root commit:`, error);
      }
    }
  }

  private startAfterCommit(event: GlobalSettingsCommitEvent): void {
    try {
      const result = this.deps.afterCommit?.(event);
      void Promise.resolve(result).catch((error) => {
        console.warn(`[LimCode] Global settings ${event.request.section} committed, but post-commit refresh failed:`, error);
      });
    } catch (error) {
      console.warn(`[LimCode] Global settings ${event.request.section} committed, but post-commit hook failed:`, error);
    }
  }

  private postSettingsError(
    requestType: BridgeMessageType.GlobalSettingsGet | BridgeMessageType.GlobalSettingsUpdate,
    section: GlobalSettingsSection,
    error: unknown,
    correlationId?: string,
    clientId?: BridgeClientId
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const isConflict = isSettingsRevisionConflictError(error);
    const envelope: ExtensionToWebviewMessage = {
      id: createMessageId(),
      type: BridgeMessageType.Error,
      channel: 'settings',
      scope: { kind: 'settings', level: 'global', id: section },
      correlationId,
      payload: {
        requestType,
        message,
        ...(isConflict ? { code: 'settings_revision_conflict' as const, actualRevision: error.actualRevision } : {})
      }
    };
    if (clientId) {
      this.deps.webview.post(clientId, envelope);
    } else if (requestType === BridgeMessageType.GlobalSettingsGet) {
      this.deps.webview.broadcastToStream(globalSettingsStreamId(section), envelope);
    }
  }

  private createSnapshotMessage(stored: GlobalSettingsStoreResult, correlationId?: string): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.GlobalSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'global', id: stored.section },
      correlationId,
      payload: {
        section: stored.section,
        settings: stored.settings,
        filePath: stored.filePath,
        revision: stored.revision
      }
    };
  }
}
