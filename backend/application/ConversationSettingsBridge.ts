import type { World } from '../ecs/types';
import type { StorageCapability, WebviewCapability } from '../capabilities/types';
import { Conversation } from '../world/modules/chat/components';
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
  requestSnapshot: (conversationId?: string) => void;
}

export class ConversationSettingsBridge {
  public constructor(private readonly deps: ConversationSettingsBridgeDeps) {}

  public async postSnapshot(clientId: BridgeClientId, conversationId: string, section: ConversationSettingsSection, correlationId?: string): Promise<void> {
    const streamId = conversationSettingsStreamId(conversationId, section);
    this.deps.webview.subscribe(clientId, streamId);
    this.deps.webview.post(clientId, this.createSnapshotMessage(await this.readSettings(conversationId, section), correlationId));
  }

  public async update(payload: ConversationSettingsUpdatePayload | undefined, correlationId?: string): Promise<void> {
    if (!payload) return;
    const settings = normalizeConversationSettings(payload.section, payload.settings);
    if (payload.section === 'common') this.applyCommonSettingsToWorld(settings);

    const stored = await this.deps.storage.saveConversationSettings(payload.section, settings);
    this.deps.webview.broadcastToStream(conversationSettingsStreamId(stored.conversationId, stored.section), this.createSnapshotMessage(stored, correlationId));
    this.deps.requestSnapshot();
    this.deps.requestSnapshot(stored.conversationId);
  }

  private async readSettings(conversationId: string, section: ConversationSettingsSection): Promise<{ conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }> {
    const stored = await this.deps.storage.loadConversationSettings(conversationId, section);
    if (section !== 'common') return stored ?? { conversationId, section, settings: { conversationId, name: conversationId }, filePath: '' };

    const entity = this.findConversation(conversationId);
    const conversation = entity === undefined ? undefined : this.deps.world.get(entity, Conversation);
    const settings = conversation
      ? { conversationId, name: conversation.title?.trim() || conversation.id }
      : (stored?.settings as ConversationSettingsRecord | undefined) ?? { conversationId, name: conversationId };
    return { conversationId, section, settings, filePath: stored?.filePath ?? '' };
  }

  private createSnapshotMessage(stored: { conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }, correlationId?: string): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: stored.conversationId },
      correlationId,
      payload: { conversationId: stored.conversationId, section: stored.section, settings: stored.settings, filePath: stored.filePath }
    };
  }

  private applyCommonSettingsToWorld(settings: ConversationSettingsRecord): void {
    const conversationId = settings.conversationId;
    const entity = this.findConversation(conversationId);
    if (entity === undefined) return;
    const conversation = this.deps.world.get(entity, Conversation);
    if (conversation) this.deps.world.add(entity, Conversation, { ...conversation, title: settings.name });
  }

  private findConversation(conversationId: string): number | undefined {
    return this.deps.world.query(Conversation).find((entity) => this.deps.world.get(entity, Conversation)?.id === conversationId);
  }
}

function normalizeConversationSettings(section: ConversationSettingsSection, settings: ConversationSettingsSectionValue): ConversationSettingsRecord {
  void section;
  const id = settings.conversationId;
  const name = settings.name.trim() || id;
  return { conversationId: id, name };
}
