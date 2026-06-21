import type { StorageCapability, WebviewCapability } from '../capabilities/types';
import {
  BridgeMessageType,
  GLOBAL_SETTINGS_SECTIONS,
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
 * common 属于扩展级配置，保存于 VS Code globalState；llm 只保存当前激活的可复用渠道配置 id。
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
        for (const section of GLOBAL_SETTINGS_SECTIONS) {
          if (section === 'common') continue;
          const nextStored = await this.deps.storage.loadGlobalSettings(section);
          this.deps.webview.broadcastToStream(
            globalSettingsStreamId(section),
            this.createSnapshotMessage(nextStored, correlationId)
          );
        }
      }
    } catch (error) {
      console.warn('[LimCode] Failed to update global settings:', error);
      this.postSettingsError(BridgeMessageType.GlobalSettingsUpdate, payload.section, error, correlationId);
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
    const envelope: ExtensionToWebviewMessage = {
      id: createMessageId(),
      type: BridgeMessageType.Error,
      channel: 'settings',
      scope: { kind: 'settings', level: 'global', id: section },
      correlationId,
      payload: {
        requestType,
        message
      }
    };
    if (clientId) this.deps.webview.post(clientId, envelope);
    else this.deps.webview.broadcast(envelope);
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
