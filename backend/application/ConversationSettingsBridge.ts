import type { World } from '../ecs/types';
import type { StorageCapability, WebviewCapability } from '../capabilities/types';
import { Session } from '../world/modules/chat/components';
import {
  BridgeMessageType,
  conversationSettingsStreamId,
  createMessageId,
  type BridgeClientId,
  type ConversationSettingsRecord,
  type ConversationSettingsSection,
  type ConversationSettingsSectionValue,
  type ConversationSettingsUpdatePayload,
  type ExtensionToWebviewMessage
} from '../../shared/protocol';

export interface ConversationSettingsBridgeDeps {
  world: World;
  storage: StorageCapability;
  webview: WebviewCapability;
  requestSnapshot: (sessionId?: string) => void;
}

/** 对话级设置桥接：通过 section 泛化读写，当前 common -> settings/common.json。 */
export class ConversationSettingsBridge {
  public constructor(private readonly deps: ConversationSettingsBridgeDeps) {}

  public async postSnapshot(
    clientId: BridgeClientId,
    sessionId: string,
    section: ConversationSettingsSection,
    correlationId?: string
  ): Promise<void> {
    const streamId = conversationSettingsStreamId(sessionId, section);
    this.deps.webview.subscribe(clientId, streamId);
    this.deps.webview.post(clientId, this.createSnapshotMessage(await this.readSettings(sessionId, section), correlationId));
  }

  public async update(payload: ConversationSettingsUpdatePayload | undefined, correlationId?: string): Promise<void> {
    if (!payload) return;

    const settings = normalizeConversationSettings(payload.section, payload.settings);
    if (payload.section === 'common') this.applyCommonSettingsToWorld(settings);

    const stored = await this.deps.storage.saveConversationSettings(payload.section, settings);
    this.deps.webview.broadcastToStream(
      conversationSettingsStreamId(stored.sessionId, stored.section),
      this.createSnapshotMessage(stored, correlationId)
    );
    this.deps.requestSnapshot();
    this.deps.requestSnapshot(stored.sessionId);
  }

  private async readSettings(
    sessionId: string,
    section: ConversationSettingsSection
  ): Promise<{ sessionId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }> {
    const stored = await this.deps.storage.loadConversationSettings(sessionId, section);
    if (section !== 'common') return stored ?? { sessionId, section, settings: { sessionId, name: sessionId }, filePath: '' };

    const entity = this.findSession(sessionId);
    const session = entity === undefined ? undefined : this.deps.world.get(entity, Session);
    const settings = session
      ? { sessionId, name: session.title?.trim() || session.id }
      : (stored?.settings as ConversationSettingsRecord | undefined) ?? { sessionId, name: sessionId };
    return { sessionId, section, settings, filePath: stored?.filePath ?? '' };
  }

  private createSnapshotMessage(
    stored: { sessionId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string },
    correlationId?: string
  ): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: stored.sessionId },
      correlationId,
      payload: {
        sessionId: stored.sessionId,
        section: stored.section,
        settings: stored.settings,
        filePath: stored.filePath
      }
    };
  }

  private applyCommonSettingsToWorld(settings: ConversationSettingsRecord): void {
    const entity = this.findSession(settings.sessionId);
    if (entity === undefined) return;
    const session = this.deps.world.get(entity, Session);
    if (session) this.deps.world.add(entity, Session, { ...session, title: settings.name });
  }

  private findSession(sessionId: string): number | undefined {
    return this.deps.world.query(Session).find((entity) => this.deps.world.get(entity, Session)?.id === sessionId);
  }
}

function normalizeConversationSettings(section: ConversationSettingsSection, settings: ConversationSettingsSectionValue): ConversationSettingsRecord {
  void section;
  const name = settings.name.trim() || settings.sessionId;
  return { sessionId: settings.sessionId, name };
}
