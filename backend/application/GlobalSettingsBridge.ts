import type { RuntimePaths, StorageCapability, WebviewCapability } from '../capabilities/types';
import {
  BridgeMessageType,
  GLOBAL_SETTINGS_STREAM_ID,
  createMessageId,
  type BridgeClientId,
  type ExtensionToWebviewMessage,
  type GlobalSettingsRecord,
  type GlobalSettingsUpdatePayload
} from '../../shared/protocol';

export interface GlobalSettingsBridgeDeps {
  storage: StorageCapability;
  webview: WebviewCapability;
  paths: RuntimePaths;
}

/**
 * 全局设置桥接。
 * LLM 设置只是 GlobalSettingsRecord.llm 的一部分；其它全局配置（如 dataFilePath）也走同一条全局设置流。
 */
export class GlobalSettingsBridge {
  public constructor(private readonly deps: GlobalSettingsBridgeDeps) {}

  public async postSnapshot(clientId?: BridgeClientId, correlationId?: string): Promise<void> {
    if (clientId) this.deps.webview.subscribe(clientId, GLOBAL_SETTINGS_STREAM_ID);

    const settings = await this.deps.storage.loadGlobalSettings();
    const message = this.createSnapshotMessage(settings, correlationId);

    if (clientId) this.deps.webview.post(clientId, message);
    else this.deps.webview.broadcastToStream(GLOBAL_SETTINGS_STREAM_ID, message);
  }

  public async update(payload: GlobalSettingsUpdatePayload | undefined, correlationId?: string): Promise<void> {
    if (!payload) return;

    const settings = await this.deps.storage.saveGlobalSettings(payload.settings);
    this.deps.webview.broadcastToStream(
      GLOBAL_SETTINGS_STREAM_ID,
      this.createSnapshotMessage(settings, correlationId)
    );
  }

  private createSnapshotMessage(settings: GlobalSettingsRecord, correlationId?: string): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.GlobalSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'global' },
      correlationId,
      payload: {
        settings,
        filePath: this.deps.paths.globalSettingsPath
      }
    };
  }
}
