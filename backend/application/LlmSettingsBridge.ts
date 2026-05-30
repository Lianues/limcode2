import type { RuntimePaths, StorageCapability, WebviewCapability } from '../capabilities/types';
import {
  BridgeMessageType,
  createMessageId,
  type BridgeClientId,
  type ExtensionToWebviewMessage,
  type LlmSettingsRecord,
  type LlmSettingsUpdatePayload
} from '../../shared/protocol';

export interface LlmSettingsBridgeDeps {
  storage: StorageCapability;
  webview: WebviewCapability;
  paths: RuntimePaths;
}

/**
 * Webview 的 LLM settings 读写桥接。
 * 负责 settings snapshot/update 的消息格式与广播，不参与 LLM 调用逻辑。
 */
export class LlmSettingsBridge {
  public constructor(private readonly deps: LlmSettingsBridgeDeps) {}

  public async postSnapshot(clientId?: BridgeClientId, correlationId?: string): Promise<void> {
    const settings = await this.deps.storage.loadLlmSettings();
    const message = this.createSnapshotMessage(settings, correlationId);

    if (clientId) this.deps.webview.post(clientId, message);
    else this.deps.webview.broadcast(message);
  }

  public async update(payload: LlmSettingsUpdatePayload | undefined, correlationId?: string): Promise<void> {
    if (!payload) return;

    const settings = await this.deps.storage.saveLlmSettings(payload.settings);
    this.deps.webview.broadcast(this.createSnapshotMessage(settings, correlationId));
  }

  private createSnapshotMessage(settings: LlmSettingsRecord, correlationId?: string): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.LlmSettingsSnapshot,
      channel: 'settings',
      correlationId,
      payload: {
        settings,
        filePath: this.deps.paths.llmSettingsPath
      }
    };
  }
}
