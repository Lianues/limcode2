import type { World } from '../ecs/types';
import type { StorageCapability, WebviewCapability } from '../capabilities/types';
import { Session } from '../world/modules/chat/components';
import {
  BridgeMessageType,
  conversationSettingsStreamId,
  createMessageId,
  type BridgeClientId,
  type ConversationSettingsRecord,
  type ConversationSettingsUpdatePayload,
  type ExtensionToWebviewMessage
} from '../../shared/protocol';

export interface ConversationSettingsBridgeDeps {
  world: World;
  storage: StorageCapability;
  webview: WebviewCapability;
  requestSnapshot: (sessionId?: string) => void;
}

/** 对话级设置桥接：当前 MVP 只包含对话名称。 */
export class ConversationSettingsBridge {
  public constructor(private readonly deps: ConversationSettingsBridgeDeps) {}

  public async postSnapshot(clientId: BridgeClientId, sessionId: string, correlationId?: string): Promise<void> {
    this.deps.webview.subscribe(clientId, conversationSettingsStreamId(sessionId));
    this.deps.webview.post(clientId, this.createSnapshotMessage(await this.readSettings(sessionId), correlationId));
  }

  public async update(payload: ConversationSettingsUpdatePayload | undefined, correlationId?: string): Promise<void> {
    if (!payload) return;

    const settings = normalizeConversationSettings(payload.settings);
    const entity = this.findSession(settings.sessionId);
    if (entity !== undefined) {
      const session = this.deps.world.get(entity, Session);
      if (session) this.deps.world.add(entity, Session, { ...session, title: settings.name });
    }

    await this.deps.storage.saveConversationSettings(settings);
    this.deps.webview.broadcastToStream(
      conversationSettingsStreamId(settings.sessionId),
      this.createSnapshotMessage(settings, correlationId)
    );
    this.deps.requestSnapshot();
    this.deps.requestSnapshot(settings.sessionId);
  }

  private async readSettings(sessionId: string): Promise<ConversationSettingsRecord> {
    const entity = this.findSession(sessionId);
    const session = entity === undefined ? undefined : this.deps.world.get(entity, Session);
    if (session) return { sessionId, name: session.title?.trim() || session.id };

    const stored = await this.deps.storage.loadConversationSettings(sessionId);
    return stored ?? { sessionId, name: sessionId };
  }

  private createSnapshotMessage(settings: ConversationSettingsRecord, correlationId?: string): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: settings.sessionId },
      correlationId,
      payload: { settings }
    };
  }

  private findSession(sessionId: string): number | undefined {
    return this.deps.world.query(Session).find((entity) => this.deps.world.get(entity, Session)?.id === sessionId);
  }
}

function normalizeConversationSettings(settings: ConversationSettingsRecord): ConversationSettingsRecord {
  const name = settings.name.trim() || settings.sessionId;
  return { sessionId: settings.sessionId, name };
}
