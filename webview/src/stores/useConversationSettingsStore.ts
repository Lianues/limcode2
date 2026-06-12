import { defineStore } from 'pinia';
import type {
  ConversationLlmSettingsRecord,
  ConversationSettingsRecord,
  ConversationSettingsSnapshotPayload
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

interface ConversationSettingsState {
  common: ConversationSettingsRecord;
  llm: ConversationLlmSettingsRecord;
  status: string;
}

function emptyCommon(conversationId = ''): ConversationSettingsRecord {
  return { conversationId, name: '' };
}

function emptyLlm(conversationId = ''): ConversationLlmSettingsRecord {
  return { conversationId, activeProviderConfigId: '' };
}

/** 对话级设置（common：对话名称；llm：当前对话渠道配置选择）。 */
export const useConversationSettingsStore = defineStore('conversationSettings', {
  state: (): ConversationSettingsState => ({
    common: emptyCommon(),
    llm: emptyLlm(),
    status: ''
  }),
  actions: {
    request(conversationId: string): void {
      if (!conversationId) return;
      // 进入对话时先占位 conversationId，避免快照未到时保存按钮不可用。
      if (this.common.conversationId !== conversationId) this.common = emptyCommon(conversationId);
      if (this.llm.conversationId !== conversationId) this.llm = emptyLlm(conversationId);
      this.status = '正在读取对话设置...';
      bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'common' });
      bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'llm' });
    },
    save(): void {
      if (!this.common.conversationId) return;
      this.status = '正在保存对话设置...';
      bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
        section: 'common',
        settings: { conversationId: this.common.conversationId, name: this.common.name }
      });
    },
    selectLlmProviderConfigForConversation(conversationId: string, configId: string): void {
      if (!conversationId || !configId) return;
      this.llm = { conversationId, activeProviderConfigId: configId };
      this.status = '正在保存对话渠道设置...';
      bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
        section: 'llm',
        settings: { conversationId, activeProviderConfigId: configId }
      });
      // 最新手动选择同步为全局默认，供新对话或未单独设置的对话回退使用。
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'llm',
        settings: { activeProviderConfigId: configId }
      });
    },
    applySnapshot(payload: ConversationSettingsSnapshotPayload): void {
      if (payload.section === 'common') {
        this.common = payload.settings as ConversationSettingsRecord;
      } else if (payload.section === 'llm') {
        this.llm = payload.settings as ConversationLlmSettingsRecord;
      }
      this.status = '对话设置已同步';
    }
  }
});
