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
      // 后端会在保存当前对话渠道后，把该渠道同步为新对话的 Global 默认值；
      // 其他已存在对话会先冻结到各自的对话级设置，避免被新的默认值影响。
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
