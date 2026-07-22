import { defineStore } from 'pinia';
import type {
  ConversationLlmSettingsRecord,
  ConversationSettingsRecord,
  ConversationSettingsSection,
  ConversationSettingsSnapshotPayload
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { ScopedEditRevision } from '@shared/scopedEditRevision';

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

interface ConversationSettingsRequestMeta {
  section: ConversationSettingsSection;
  conversationId: string;
  llmRevision?: number;
}

const conversationSettingsRequests = new Map<string, ConversationSettingsRequestMeta>();
const llmEditRevisions = new ScopedEditRevision();

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

function currentLlmEditRevision(conversationId: string): number {
  return llmEditRevisions.current(conversationId);
}

function nextLlmEditRevision(conversationId: string): number {
  return llmEditRevisions.next(conversationId);
}

function rememberConversationSettingsRequest(
  section: ConversationSettingsSection,
  requestId: string,
  conversationId: string,
  llmRevision?: number
): void {
  conversationSettingsRequests.set(requestId, {
    section,
    conversationId,
    ...(llmRevision !== undefined ? { llmRevision } : {})
  });
}

function takeConversationSettingsRequest(requestId: string | undefined): ConversationSettingsRequestMeta | undefined {
  if (!requestId) return undefined;
  const request = conversationSettingsRequests.get(requestId);
  if (request) conversationSettingsRequests.delete(requestId);
  return request;
}

function isStaleLlmSettingsResponse(request: ConversationSettingsRequestMeta | undefined, conversationId: string): boolean {
  return request?.section === 'llm'
    && llmEditRevisions.isStale(conversationId, request.llmRevision);
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
      rememberConversationSettingsRequest(
        'common',
        bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'common' }),
        conversationId
      );
      rememberConversationSettingsRequest(
        'llm',
        bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'llm' }),
        conversationId,
        currentLlmEditRevision(conversationId)
      );
    },
    save(): void {
      if (!this.common.conversationId) return;
      this.markPendingSettingSection('common');
      this.status = '正在保存对话设置...';
      rememberConversationSettingsRequest(
        'common',
        bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
          section: 'common',
          settings: { conversationId: this.common.conversationId, name: this.common.name }
        }),
        this.common.conversationId
      );
    },
    selectLlmProviderConfigForConversation(conversationId: string, configId: string): void {
      if (!conversationId || !configId) return;
      const modelOverrides = normalizeModelOverrides(this.llm.conversationId === conversationId ? this.llm.modelOverrides : undefined);
      this.llm = { conversationId, activeProviderConfigId: configId, ...(modelOverrides ? { modelOverrides } : {}) };
      const settings = normalizeLlmSettings(this.llm);
      this.markPendingSettingSection('llm');
      this.status = '正在保存对话渠道设置...';
      const revision = nextLlmEditRevision(conversationId);
      rememberConversationSettingsRequest(
        'llm',
        bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
          section: 'llm',
          settings
        }),
        conversationId,
        revision
      );
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
      const revision = nextLlmEditRevision(conversationId);
      rememberConversationSettingsRequest(
        'llm',
        bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
          section: 'llm',
          settings
        }),
        conversationId,
        revision
      );
    },
    applySnapshot(payload: ConversationSettingsSnapshotPayload, correlationId?: string): void {
      const request = takeConversationSettingsRequest(correlationId);
      const conversationId = payload.section === 'llm'
        ? (payload.settings as ConversationLlmSettingsRecord).conversationId
        : (payload.settings as ConversationSettingsRecord).conversationId;
      const activeConversationId = payload.section === 'llm' ? this.llm.conversationId : this.common.conversationId;
      // 切换会话后迟到的旧会话 snapshot 不能污染当前会话设置或结束当前会话的 loading/pending。
      if (activeConversationId && conversationId !== activeConversationId) return;
      this.loadedSections[payload.section] = true;
      this.clearLoadingSettingSection(payload.section);

      // 快速来回切换模型时，较早保存/读取请求的 snapshot 可能晚于新请求返回。
      // 旧 snapshot 只能用于结束自己的请求，不能覆盖当前本地选择，也不能清掉较新请求的 pending 状态。
      if (payload.section === 'llm' && (
        isStaleLlmSettingsResponse(request, conversationId)
        || (!request && this.pendingSettingsSections.llm === true)
      )) {
        if (!hasOutstandingSettingsWork(this)) this.status = '对话设置已同步';
        return;
      }

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
      const request = takeConversationSettingsRequest(options.correlationId);
      const section = options.section ?? request?.section;
      const activeConversationId = section === 'llm' ? this.llm.conversationId : section === 'common' ? this.common.conversationId : '';
      if (request && activeConversationId && request.conversationId !== activeConversationId) return;
      if (section === 'llm' && request && isStaleLlmSettingsResponse(request, request.conversationId)) return;
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
