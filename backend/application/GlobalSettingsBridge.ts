import type { StorageCapability, WebviewCapability } from '../capabilities/types';
import {
  BridgeMessageType,
  globalSettingsStreamId,
  createMessageId,
  type BridgeClientId,
  type ExtensionToWebviewMessage,
  type GlobalSettingsRecord,
  type GlobalSettingsSection,
  type GlobalSettingsUpdatePayload
} from '../../shared/protocol';

export interface GlobalSettingsBridgeDeps {
  storage: StorageCapability;
  webview: WebviewCapability;
  beforeDataRootChange?: () => Promise<void>;
}

/**
 * 全局设置桥接。
 * common 属于扩展级配置，保存于 VS Code globalState；llm 属于可迁移数据，保存于当前 dataRoot/settings/llm.json。
 */
export class GlobalSettingsBridge {
  public constructor(private readonly deps: GlobalSettingsBridgeDeps) {}

  public async postSnapshot(clientId: BridgeClientId | undefined, section: GlobalSettingsSection, correlationId?: string): Promise<void> {
    const streamId = globalSettingsStreamId(section);
    if (clientId) this.deps.webview.subscribe(clientId, streamId);

    const stored = await this.deps.storage.loadGlobalSettings(section);
    const message = this.createSnapshotMessage(stored, correlationId);

    if (clientId) this.deps.webview.post(clientId, message);
    else this.deps.webview.broadcastToStream(streamId, message);
  }

  public async update(payload: GlobalSettingsUpdatePayload | undefined, correlationId?: string): Promise<void> {
    if (!payload) return;

    try {
      const dataRootPathChanged = payload.section === 'common' && await this.isDataRootPathChange(payload);
      if (dataRootPathChanged) {
        await this.deps.beforeDataRootChange?.();
      }

      const stored = await this.deps.storage.saveGlobalSettings(payload.section, payload.settings);
      this.deps.webview.broadcastToStream(
        globalSettingsStreamId(payload.section),
        this.createSnapshotMessage(stored, correlationId)
      );
      if (dataRootPathChanged) {
        const llmSettings = await this.deps.storage.loadGlobalSettings('llm');
        this.deps.webview.broadcastToStream(
          globalSettingsStreamId('llm'),
          this.createSnapshotMessage(llmSettings, correlationId)
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[LimCode] Failed to update global settings:', error);
      this.deps.webview.broadcast({
        id: createMessageId(),
        type: BridgeMessageType.Error,
        channel: 'settings',
        scope: { kind: 'settings', level: 'global', id: payload.section },
        correlationId,
        payload: {
          requestType: BridgeMessageType.GlobalSettingsUpdate,
          message
        }
      });
    }
  }

  private createSnapshotMessage(
    stored: Awaited<ReturnType<StorageCapability['loadGlobalSettings']>>,
    correlationId?: string
  ): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.GlobalSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'global', id: stored.section },
      correlationId,
      payload: {
        section: stored.section,
        settings: stored.settings,
        filePath: stored.filePath
      }
    };
  }

  private async isDataRootPathChange(payload: GlobalSettingsUpdatePayload): Promise<boolean> {
    const current = await this.deps.storage.loadGlobalSettings('common');
    const currentSettings = current.settings as GlobalSettingsRecord;
    const nextSettings = payload.settings as Partial<GlobalSettingsRecord> | undefined;
    return (nextSettings?.dataFilePath ?? '').trim() !== currentSettings.dataFilePath.trim();
  }
}
