import { defineStore } from 'pinia';
import type {
  ConversationLlmSettingsRecord,
  ConversationSettingsRecord,
  ConversationSettingsSection,
  ConversationSettingsSnapshotPayload
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

interface ConversationSettingsState {
  common: ConversationSettingsRecord;
  llm: ConversationLlmSettingsRecord;
  loadedSections: Partial<Record<ConversationSettingsSection, boolean>>;
  loadingSettingsSections: Partial<Record<ConversationSettingsSection, boolean>>;
  pendingSettingsSections: Partial<Record<ConversationSettingsSection, boolean>>;
  failedSettingsSections: Partial<Record<ConversationSettingsSection, string>>;
  status: string;
}

interface ConversationSettingsErrorOptions {
  requestType?: string;
  section?: ConversationSettingsSection;
  correlationId?: string;
}

const conversationSettingsRequestSections = new Map<string, ConversationSettingsSection>();

function emptyCommon(conversationId = ''): ConversationSettingsRecord {
  return { conversationId, name: '' };
}

function emptyLlm(conversationId = ''): ConversationLlmSettingsRecord {
  return { conversationId, activeProviderConfigId: '' };
}

function normalizeModelOverrides(value: ConversationLlmSettingsRecord['modelOverrides'] | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value)
    .map(([configId, modelId]) => [configId.trim(), modelId.trim()] as const)
    .filter(([configId, modelId]) => !!configId && !!modelId);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeLlmSettings(settings: ConversationLlmSettingsRecord): ConversationLlmSettingsRecord {
  const modelOverrides = normalizeModelOverrides(settings.modelOverrides);
  return {
    conversationId: settings.conversationId,
    activeProviderConfigId: settings.activeProviderConfigId,
    ...(modelOverrides ? { modelOverrides } : {})
  };
}

function hasOutstandingSettingsWork(state: ConversationSettingsState): boolean {
  return Object.keys(state.loadingSettingsSections).length > 0 || Object.keys(state.pendingSettingsSections).length > 0;
}

function settingsErrorStatus(requestType: string | undefined, message: string): string {
  if (requestType === BridgeMessageType.ConversationSettingsGet) return `对话设置读取失败：${message}`;
  return `对话设置保存失败：${message}`;
}

function rememberConversationSettingsRequest(section: ConversationSettingsSection, requestId: string): void {
  conversationSettingsRequestSections.set(requestId, section);
}

function takeConversationSettingsRequestSection(requestId: string | undefined): ConversationSettingsSection | undefined {
  if (!requestId) return undefined;
  const section = conversationSettingsRequestSections.get(requestId);
  if (section) conversationSettingsRequestSections.delete(requestId);
  return section;
}

/** 对话级设置（common：对话名称；llm：当前对话渠道配置选择）。 */
export const useConversationSettingsStore = defineStore('conversationSettings', {
  state: (): ConversationSettingsState => ({
    common: emptyCommon(),
    llm: emptyLlm(),
    loadedSections: {},
    loadingSettingsSections: {},
    pendingSettingsSections: {},
    failedSettingsSections: {},
    status: ''
  }),
  actions: {
    markLoadingSettingSection(section: ConversationSettingsSection): void {
      this.loadingSettingsSections[section] = true;
      delete this.failedSettingsSections[section];
    },
    clearLoadingSettingSection(section: ConversationSettingsSection): void {
      delete this.loadingSettingsSections[section];
    },
    markPendingSettingSection(section: ConversationSettingsSection): void {
      this.pendingSettingsSections[section] = true;
      delete this.failedSettingsSections[section];
    },
    clearPendingSettingSection(section: ConversationSettingsSection): void {
      delete this.pendingSettingsSections[section];
    },
    request(conversationId: string): void {
      if (!conversationId) return;
      // 进入对话时先占位 conversationId，避免快照未到时保存按钮不可用。
      if (this.common.conversationId !== conversationId) this.common = emptyCommon(conversationId);
      if (this.llm.conversationId !== conversationId) this.llm = emptyLlm(conversationId);
      this.loadedSections = {};
      this.loadingSettingsSections = {};
      this.pendingSettingsSections = {};
      this.failedSettingsSections = {};
      this.status = '正在读取对话设置...';
      this.markLoadingSettingSection('common');
      this.markLoadingSettingSection('llm');
      rememberConversationSettingsRequest('common', bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'common' }));
      rememberConversationSettingsRequest('llm', bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'llm' }));
    },
    save(): void {
      if (!this.common.conversationId) return;
      this.markPendingSettingSection('common');
      this.status = '正在保存对话设置...';
      rememberConversationSettingsRequest('common', bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
        section: 'common',
        settings: { conversationId: this.common.conversationId, name: this.common.name }
      }));
    },
    selectLlmProviderConfigForConversation(conversationId: string, configId: string): void {
      if (!conversationId || !configId) return;
      const modelOverrides = normalizeModelOverrides(this.llm.conversationId === conversationId ? this.llm.modelOverrides : undefined);
      this.llm = { conversationId, activeProviderConfigId: configId, ...(modelOverrides ? { modelOverrides } : {}) };
      const settings = normalizeLlmSettings(this.llm);
      this.markPendingSettingSection('llm');
      this.status = '正在保存对话渠道设置...';
      rememberConversationSettingsRequest('llm', bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
        section: 'llm',
        settings
      }));
      // 后端会在保存当前对话渠道后，把该渠道同步为新对话的 Global 默认值；
      // 其他已存在对话会先冻结到各自的对话级设置，避免被新的默认值影响。
    },
    selectLlmModelForConversation(conversationId: string, providerConfigId: string, modelId: string): void {
      const configId = providerConfigId.trim();
      const selectedModelId = modelId.trim();
      if (!conversationId || !configId || !selectedModelId) return;
      const current = this.llm.conversationId === conversationId ? this.llm : emptyLlm(conversationId);
      const overrides = {
        ...(normalizeModelOverrides(current.modelOverrides) ?? {}),
        [configId]: selectedModelId
      };
      this.llm = {
        conversationId,
        activeProviderConfigId: configId,
        modelOverrides: overrides
      };
      const settings = normalizeLlmSettings(this.llm);
      this.markPendingSettingSection('llm');
      this.status = '正在保存对话模型设置...';
      rememberConversationSettingsRequest('llm', bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
        section: 'llm',
        settings
      }));
    },
    applySnapshot(payload: ConversationSettingsSnapshotPayload, correlationId?: string): void {
      takeConversationSettingsRequestSection(correlationId);
      this.loadedSections[payload.section] = true;
      this.clearLoadingSettingSection(payload.section);
      this.clearPendingSettingSection(payload.section);
      delete this.failedSettingsSections[payload.section];
      if (payload.section === 'common') {
        this.common = payload.settings as ConversationSettingsRecord;
      } else if (payload.section === 'llm') {
        const next = normalizeLlmSettings(payload.settings as ConversationLlmSettingsRecord);
        this.llm = next;
      }
      if (!hasOutstandingSettingsWork(this)) this.status = '对话设置已同步';
    },
    setError(message: string, options: ConversationSettingsErrorOptions = {}): void {
      const section = options.section ?? takeConversationSettingsRequestSection(options.correlationId);
      if (section) {
        this.clearLoadingSettingSection(section);
        this.clearPendingSettingSection(section);
        this.failedSettingsSections[section] = message;
      } else {
        this.loadingSettingsSections = {};
        this.pendingSettingsSections = {};
      }
      this.status = settingsErrorStatus(options.requestType, message);
    }
  }
});
