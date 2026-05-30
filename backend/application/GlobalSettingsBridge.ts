import type { RuntimePaths, StorageCapability, WebviewCapability } from '../capabilities/types';
import {
  BridgeMessageType,
  globalSettingsStreamId,
  createMessageId,
  type BridgeClientId,
  type ExtensionToWebviewMessage,
  type GlobalSettingsSection,
  type GlobalSettingsUpdatePayload
} from '../../shared/protocol';

export interface GlobalSettingsBridgeDeps {
  storage: StorageCapability;
  webview: WebviewCapability;
  paths: RuntimePaths;
}

/**
 * 全局设置桥接。
 * 通过 section 泛化读写：common -> settings/common.json，llm -> settings/llm.json。
 * 后续新增全局设置文件时，只需要扩展 shared section 与 storage section spec。
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

    const stored = await this.deps.storage.saveGlobalSettings(payload.section, payload.settings);
    this.deps.webview.broadcastToStream(
      globalSettingsStreamId(payload.section),
      this.createSnapshotMessage(stored, correlationId)
    );
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
}
