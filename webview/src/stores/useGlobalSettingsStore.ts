import { defineStore } from 'pinia';
import {
  GLOBAL_SETTINGS_SECTIONS,
  createMessageId,
  type CheckpointMaintenanceSettingsRecord,
  type GlobalSettingsRecord,
  type GlobalSettingsSection,
  type GlobalSettingsSnapshotPayload,
  type LlmGenerationConfigRecord,
  type LlmCompressionConfigRecord,
  type LlmCompressionConfigsRecord,
  type LlmCompressionSettingsRecord,
  type LlmProviderKind,
  type LlmProviderHeadersRecord,
  type LlmProviderConfigRecord,
  type LlmProviderModelRecord,
  type LlmRequestBodyJsonValue,
  type LlmRequestBodyRecord,
  type LlmProviderModelsSnapshotPayload,
  type LlmProviderConfigsRecord,
  type LlmSettingsRecord
} from '@shared/protocol';
import { createDefaultLlmCompressionConfig } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

type SelectableCompressionMethodKind = 'openai_responses_compact' | 'llm_summary' | 'deterministic_summary';

interface FetchedModelsDialogState {
  open: boolean;
  loading: boolean;
  configId: string;
  models: LlmProviderModelRecord[];
}

interface GlobalSettingsState {
  common: GlobalSettingsRecord;
  /** LLM 全局选择信息：只保存当前激活的可复用渠道配置 id。 */
  llm: LlmSettingsRecord;
  /** 全局范围内可复用的渠道配置集合。 */
  llmProviderConfigs: LlmProviderConfigsRecord;
  llmCompression: LlmCompressionSettingsRecord;
  llmCompressionConfigs: LlmCompressionConfigsRecord;
  /** 存档点维护：自动清理未使用 shadow 仓库的设置。 */
  checkpointMaintenance: CheckpointMaintenanceSettingsRecord;
  /** 各 section 的来源文件路径，用于在 UI 展示。 */
  filePaths: Partial<Record<GlobalSettingsSection, string>>;
  /** 等待 llmProviderConfigs 保存完成后再持久化的 active provider id，避免 active id 先于新配置到达后端。 */
  pendingActiveProviderConfigIdAfterConfigsSave: string;
  /** 已收到后端 snapshot 的全局设置 section。 */
  loadedSections: Partial<Record<GlobalSettingsSection, boolean>>;
  /** 获取模型后等待用户选择导入的临时列表。 */
  fetchedModelsDialog: FetchedModelsDialogState;
  /** 已发起更新，正在等待后端 snapshot 确认的全局设置 section。 */
  pendingSettingsSections: Partial<Record<GlobalSettingsSection, boolean>>;
  status: string;
}

function emptyCommon(): GlobalSettingsRecord {
  return { dataFilePath: '', activeDataRootPath: '', defaultDataRootPath: '' };
}

function emptyLlm(): LlmSettingsRecord {
  return { activeProviderConfigId: '' };
}

function emptyLlmProviderConfigs(): LlmProviderConfigsRecord {
  return { configs: [] };
}

function emptyLlmCompression(): LlmCompressionSettingsRecord {
  return { providerBindings: [] };
}

function emptyLlmCompressionConfigs(): LlmCompressionConfigsRecord {
  return { configs: [] };
}

function emptyCheckpointMaintenance(): CheckpointMaintenanceSettingsRecord {
  return { autoCleanupEnabled: true, autoCleanupDays: 7, autoDismissEnabled: true, autoDismissSeconds: 5 };
}

function emptyFetchedModelsDialog(): FetchedModelsDialogState {
  return { open: false, loading: false, configId: '', models: [] };
}

function providerDefaultBaseUrl(provider: LlmProviderKind): string {
  switch (provider) {
    case 'claude':
      return 'https://api.anthropic.com/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'openai-responses':
    case 'openai-compatible':
    default:
      return 'https://api.openai.com/v1';
  }
}

function createDefaultProviderConfig(name = '新渠道配置', provider: LlmProviderKind = 'openai-compatible'): LlmProviderConfigRecord {
  const now = Date.now();
  return {
    id: `llm-provider-config-${createMessageId()}`,
    name,
    provider,
    baseUrl: providerDefaultBaseUrl(provider),
    model: '',
    models: [],
    apiKey: '',
    toolCallFormat: 'function-call',
    stream: true,
    proxy: '',
    headers: {},
    generationConfig: {},
    requestBody: {},
    createdAt: now,
    updatedAt: now
  };
}

function normalizeProviderConfigForUi(config: LlmProviderConfigRecord): LlmProviderConfigRecord {
  const model = config.model?.trim() ?? '';
  return {
    ...config,
    model,
    models: normalizeModelsForUi(config.models, model),
    proxy: config.proxy ?? '',
    stream: config.stream !== false,
    headers: sanitizeHeaders(config.headers) ?? {},
    generationConfig: normalizeGenerationConfigForUi(config.generationConfig) ?? {},
    requestBody: sanitizeRequestBody(config.requestBody) ?? {}
  };
}

function normalizeModelsForUi(models: LlmProviderModelRecord[] | undefined, activeModel: string): LlmProviderModelRecord[] {
  const byId = new Map<string, LlmProviderModelRecord>();
  for (const item of models ?? []) {
    const id = item.id.trim();
    if (!id) continue;
    const name = item.name.trim() || id;
    const createdAt = item.createdAt?.trim();
    byId.set(id, { id, name, ...(createdAt ? { createdAt } : {}) });
  }
  if (activeModel && !byId.has(activeModel)) byId.set(activeModel, { id: activeModel, name: activeModel });
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizeModels(models: LlmProviderModelRecord[]): LlmProviderModelRecord[] {
  const byId = new Map<string, LlmProviderModelRecord>();
  for (const item of models) {
    const id = item.id.trim();
    if (!id) continue;
    const name = item.name.trim() || id;
    const createdAt = item.createdAt?.trim();
    byId.set(id, { id, name, ...(createdAt ? { createdAt } : {}) });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizeHeaders(input: LlmProviderHeadersRecord | undefined): LlmProviderHeadersRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const headers: LlmProviderHeadersRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    headers[key] = String(rawValue).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeGenerationConfigForUi(input: LlmGenerationConfigRecord | undefined): LlmGenerationConfigRecord | undefined {
  return sanitizeGenerationConfig(input);
}

function sanitizeGenerationConfig(input: LlmGenerationConfigRecord | undefined): LlmGenerationConfigRecord | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const config: LlmGenerationConfigRecord = {};
  assignFiniteNumber(config, 'temperature', input.temperature);
  assignFiniteNumber(config, 'topP', input.topP);
  assignFiniteNumber(config, 'topK', input.topK);
  assignFiniteNumber(config, 'maxOutputTokens', input.maxOutputTokens);

  const thinkingConfig = input.thinkingConfig;
  if (thinkingConfig && typeof thinkingConfig === 'object') {
    const nextThinking: NonNullable<LlmGenerationConfigRecord['thinkingConfig']> = {};
    if (typeof thinkingConfig.includeThoughts === 'boolean') nextThinking.includeThoughts = thinkingConfig.includeThoughts;
    assignFiniteNumber(nextThinking, 'thinkingBudget', thinkingConfig.thinkingBudget);
    if (isKnownThinkingLevel(thinkingConfig.thinkingLevel)) nextThinking.thinkingLevel = thinkingConfig.thinkingLevel;
    if (Object.keys(nextThinking).length > 0) config.thinkingConfig = nextThinking;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function assignFiniteNumber(target: object, key: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  (target as Record<string, unknown>)[key] = value;
}

function isKnownThinkingLevel(value: unknown): value is NonNullable<NonNullable<LlmGenerationConfigRecord['thinkingConfig']>['thinkingLevel']> {
  return value === 'not-set'
    || value === 'non-set'
    || value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max';
}

function sanitizeRequestBody(input: LlmRequestBodyRecord | undefined): LlmRequestBodyRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record: LlmRequestBodyRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    const value = sanitizeJsonValue(rawValue);
    if (value !== undefined) record[key] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function sanitizeJsonValue(value: unknown): LlmRequestBodyJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: LlmRequestBodyJsonValue[] = [];
    for (const item of value) {
      const normalized = sanitizeJsonValue(item);
      if (normalized !== undefined) items.push(normalized);
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const record: Record<string, LlmRequestBodyJsonValue> = {};
    for (const [rawKey, rawChild] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) continue;
      const child = sanitizeJsonValue(rawChild);
      if (child !== undefined) record[key] = child;
    }
    return record;
  }
  return undefined;
}

function toPlainProviderConfig(config: LlmProviderConfigRecord): LlmProviderConfigRecord {
  return {
    id: config.id,
    name: config.name,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    models: sanitizeModels(config.models),
    apiKey: config.apiKey,
    toolCallFormat: config.toolCallFormat,
    stream: config.stream !== false,
    ...(config.proxy?.trim() ? { proxy: config.proxy.trim() } : {}),
    ...(sanitizeHeaders(config.headers) ? { headers: sanitizeHeaders(config.headers) } : {}),
    ...(sanitizeGenerationConfig(config.generationConfig) ? { generationConfig: sanitizeGenerationConfig(config.generationConfig) } : {}),
    ...(sanitizeRequestBody(config.requestBody) ? { requestBody: sanitizeRequestBody(config.requestBody) } : {}),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

let modelFetchTimeout: number | undefined;
const LLM_PROVIDER_CONFIGS_AUTOSAVE_DELAY_MS = 400;
let llmProviderConfigsAutoSaveTimer: number | undefined;
let llmProviderConfigsEditRevision = 0;
const llmProviderConfigsSaveRequestRevisions = new Map<string, number>();

function touchLlmProviderConfigsRevision(): number {
  llmProviderConfigsEditRevision += 1;
  return llmProviderConfigsEditRevision;
}

function clearLlmProviderConfigsAutoSaveTimer(): void {
  if (llmProviderConfigsAutoSaveTimer === undefined) return;
  window.clearTimeout(llmProviderConfigsAutoSaveTimer);
  llmProviderConfigsAutoSaveTimer = undefined;
}

function hasPendingLlmProviderConfigsSave(): boolean {
  return llmProviderConfigsAutoSaveTimer !== undefined || llmProviderConfigsSaveRequestRevisions.size > 0;
}

function clearModelFetchTimeout(): void {
  if (modelFetchTimeout === undefined) return;
  window.clearTimeout(modelFetchTimeout);
  modelFetchTimeout = undefined;
}

function startModelFetchTimeout(onTimeout: () => void): void {
  clearModelFetchTimeout();
  modelFetchTimeout = window.setTimeout(onTimeout, 60_000);
}

/** 全局设置（数据目录 + LLM 渠道配置）表单 store。组件只读 state + 调 action，传输细节收口在此。 */
export const useGlobalSettingsStore = defineStore('globalSettings', {
  state: (): GlobalSettingsState => ({
    common: emptyCommon(),
    llm: emptyLlm(),
    llmProviderConfigs: emptyLlmProviderConfigs(),
    llmCompression: emptyLlmCompression(),
    llmCompressionConfigs: emptyLlmCompressionConfigs(),
    checkpointMaintenance: emptyCheckpointMaintenance(),
    filePaths: {},
    pendingActiveProviderConfigIdAfterConfigsSave: '',
    loadedSections: {},
    fetchedModelsDialog: emptyFetchedModelsDialog(),
    pendingSettingsSections: {},
    status: ''
  }),
  getters: {
    activeLlmProviderConfig(state): LlmProviderConfigRecord | undefined {
      return state.llmProviderConfigs.configs.find((config) => config.id === state.llm.activeProviderConfigId)
        ?? state.llmProviderConfigs.configs[0];
    },
    activeCompressionConfig(state): LlmCompressionConfigRecord | undefined {
      const activeProviderId = state.llm.activeProviderConfigId;
      const binding = activeProviderId ? state.llmCompression.providerBindings.find((item) => item.providerConfigId === activeProviderId) : undefined;
      const id = binding?.compressionConfigId ?? state.llmCompression.defaultConfigId;
      return state.llmCompressionConfigs.configs.find((config) => config.id === id) ?? state.llmCompressionConfigs.configs[0];
    },
    isChannelSettingsLoading(state): boolean {
      return !state.loadedSections.llm
        || !state.loadedSections.llmProviderConfigs
        || !state.loadedSections.llmCompression
        || !state.loadedSections.llmCompressionConfigs
        || !!state.pendingSettingsSections.llm
        || !!state.pendingSettingsSections.llmProviderConfigs
        || !!state.pendingSettingsSections.llmCompression
        || !!state.pendingSettingsSections.llmCompressionConfigs;
    },
    channelSettingsLoadingText(state): string {
      if (!state.loadedSections.llm || !state.loadedSections.llmProviderConfigs || !state.loadedSections.llmCompression || !state.loadedSections.llmCompressionConfigs) return '正在加载渠道配置...';
      if (state.pendingSettingsSections.llmProviderConfigs) return '正在同步渠道配置...';
      if (state.pendingSettingsSections.llm) return '正在切换渠道...';
      return '正在加载渠道配置...';
    }
  },
  actions: {
    markPendingSettingSection(section: GlobalSettingsSection): void {
      this.pendingSettingsSections[section] = true;
    },
    clearPendingSettingSection(section: GlobalSettingsSection): void {
      delete this.pendingSettingsSections[section];
    },
    requestAll(): void {
      clearLlmProviderConfigsAutoSaveTimer();
      llmProviderConfigsSaveRequestRevisions.clear();
      this.status = '正在读取设置...';
      this.loadedSections = {};
      this.pendingSettingsSections = {};
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        this.markPendingSettingSection(section);
        bridge.request(BridgeMessageType.GlobalSettingsGet, { section });
      }
    },
    requestChannelSettings(): void {
      for (const section of ['llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs'] as const) {
        if (this.loadedSections[section] || this.pendingSettingsSections[section]) continue;
        this.markPendingSettingSection(section);
        bridge.request(BridgeMessageType.GlobalSettingsGet, { section });
      }
    },
    saveCommon(): void {
      this.status = '正在保存设置，并按需迁移、删除旧数据目录中的插件数据...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'common',
        settings: {
          dataFilePath: this.common.dataFilePath,
          activeDataRootPath: this.common.activeDataRootPath,
          defaultDataRootPath: this.common.defaultDataRootPath
        }
      });
    },
    saveLlm(): void {
      this.markPendingSettingSection('llm');
      this.status = '正在保存当前渠道选择...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'llm',
        settings: {
          activeProviderConfigId: this.llm.activeProviderConfigId
        }
      });
    },
    ensureCheckpointMaintenance(): void {
      if (this.loadedSections.checkpointMaintenance || this.pendingSettingsSections.checkpointMaintenance) return;
      this.markPendingSettingSection('checkpointMaintenance');
      bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'checkpointMaintenance' });
    },
    setCheckpointMaintenance(patch: Partial<CheckpointMaintenanceSettingsRecord>): void {
      const next = { ...this.checkpointMaintenance, ...patch };
      next.autoCleanupDays = Math.min(3650, Math.max(1, Math.floor(next.autoCleanupDays || 7)));
      next.autoDismissSeconds = Math.min(600, Math.max(1, Math.floor(next.autoDismissSeconds || 5)));
      this.checkpointMaintenance = next;
      this.saveCheckpointMaintenance();
    },
    saveCheckpointMaintenance(): void {
      this.markPendingSettingSection('checkpointMaintenance');
      this.status = '正在保存存档点维护设置...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'checkpointMaintenance',
        settings: {
          autoCleanupEnabled: this.checkpointMaintenance.autoCleanupEnabled,
          autoCleanupDays: this.checkpointMaintenance.autoCleanupDays,
          autoDismissEnabled: this.checkpointMaintenance.autoDismissEnabled,
          autoDismissSeconds: this.checkpointMaintenance.autoDismissSeconds
        }
      });
    },
    queueLlmProviderConfigsAutoSave(): void {
      touchLlmProviderConfigsRevision();
      clearLlmProviderConfigsAutoSaveTimer();
      this.markPendingSettingSection('llmProviderConfigs');
      this.status = '正在自动保存渠道配置...';
      llmProviderConfigsAutoSaveTimer = window.setTimeout(() => {
        llmProviderConfigsAutoSaveTimer = undefined;
        this.saveLlmProviderConfigs();
      }, LLM_PROVIDER_CONFIGS_AUTOSAVE_DELAY_MS);
    },
    saveLlmProviderConfigs(): void {
      clearLlmProviderConfigsAutoSaveTimer();
      const requestRevision = touchLlmProviderConfigsRevision();
      this.markPendingSettingSection('llmProviderConfigs');
      this.status = '正在自动保存渠道配置...';
      const requestId = bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'llmProviderConfigs',
        settings: {
          configs: this.llmProviderConfigs.configs.map((config) => {
            const plain = toPlainProviderConfig(config);
            return {
              ...plain,
              name: plain.name.trim() || '未命名渠道',
              apiKey: plain.apiKey.trim(),
              baseUrl: plain.baseUrl.trim(),
              model: plain.model.trim(),
              updatedAt: Date.now()
            };
          })
        }
      });
      llmProviderConfigsSaveRequestRevisions.set(requestId, requestRevision);
    },
    saveLlmCompression(): void {
      this.markPendingSettingSection('llmCompression');
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, { section: 'llmCompression', settings: this.llmCompression });
    },
    saveLlmCompressionConfigs(): void {
      this.markPendingSettingSection('llmCompressionConfigs');
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, { section: 'llmCompressionConfigs', settings: { configs: this.llmCompressionConfigs.configs.map((config) => ({ ...config, updatedAt: Date.now() })) } });
    },
    selectCompressionConfigForActiveProvider(configId: string): void {
      if (!this.llmCompressionConfigs.configs.some((config) => config.id === configId)) return;
      const providerConfigId = this.llm.activeProviderConfigId || this.activeLlmProviderConfig?.id || '';
      if (!providerConfigId) {
        this.llmCompression.defaultConfigId = configId;
      } else {
        const now = Date.now();
        const existing = this.llmCompression.providerBindings.find((item) => item.providerConfigId === providerConfigId);
        if (existing) {
          existing.compressionConfigId = configId;
          existing.updatedAt = now;
        } else {
          this.llmCompression.providerBindings.push({ id: `llm-compression-binding-${providerConfigId}`, providerConfigId, compressionConfigId: configId, role: 'default', createdAt: now, updatedAt: now });
        }
      }
      this.saveLlmCompression();
    },
    createCompressionConfig(name = '新压缩方法'): void {
      const config = createDefaultLlmCompressionConfig(name.trim() || '新压缩方法');
      this.llmCompressionConfigs.configs.push(config);
      this.llmCompression.defaultConfigId = config.id;
      this.saveLlmCompressionConfigs();
      this.saveLlmCompression();
    },
    updateCompressionConfig(configId: string, patch: Partial<LlmCompressionConfigRecord>): void {
      const config = this.llmCompressionConfigs.configs.find((item) => item.id === configId);
      if (!config) return;
      Object.assign(config, patch, { updatedAt: Date.now() });
      this.saveLlmCompressionConfigs();
    },
    setActiveCompressionMethodKind(kind: SelectableCompressionMethodKind): void {
      const activeProvider = this.activeLlmProviderConfig;
      const safeKind: SelectableCompressionMethodKind = activeProvider?.provider !== 'openai-responses' && kind === 'openai_responses_compact'
        ? 'llm_summary'
        : kind;
      let config = this.activeCompressionConfig;
      if (!config) {
        config = createDefaultLlmCompressionConfig('默认压缩方法');
        this.llmCompressionConfigs.configs.push(config);
        this.llmCompression.defaultConfigId = config.id;
      }
      config.kind = safeKind;
      if (safeKind === 'openai_responses_compact') {
        config.openaiResponsesCompact = { ...(config.openaiResponsesCompact ?? {}), createSummaryFallback: true };
      }
      if (safeKind === 'llm_summary' && !config.llmSummary) {
        config.llmSummary = createDefaultLlmCompressionConfig('临时').llmSummary;
      }
      config.updatedAt = Date.now();
      this.saveLlmCompressionConfigs();
      this.selectCompressionConfigForActiveProvider(config.id);
    },
    setActiveCompressionProviderConfig(providerConfigId: string): void {
      let config = this.activeCompressionConfig;
      if (!config) {
        config = createDefaultLlmCompressionConfig('默认压缩方法');
        this.llmCompressionConfigs.configs.push(config);
        this.llmCompression.defaultConfigId = config.id;
      }
      const id = providerConfigId.trim();
      const applyProvider = <T extends { providerConfigId?: string }>(target: T): T => {
        if (id) target.providerConfigId = id;
        else delete target.providerConfigId;
        return target;
      };
      config.openaiResponsesCompact = applyProvider({ ...(config.openaiResponsesCompact ?? {}), createSummaryFallback: config.openaiResponsesCompact?.createSummaryFallback ?? true });
      config.llmSummary = applyProvider({ ...(config.llmSummary ?? createDefaultLlmCompressionConfig('临时').llmSummary ?? {}) });
      const selectedProvider = id ? this.llmProviderConfigs.configs.find((item) => item.id === id) : this.activeLlmProviderConfig;
      if (selectedProvider?.provider !== 'openai-responses' && config.kind === 'openai_responses_compact') config.kind = 'llm_summary';
      config.updatedAt = Date.now();
      this.saveLlmCompressionConfigs();
      this.selectCompressionConfigForActiveProvider(config.id);
    },



    selectLlmProviderConfig(configId: string): void {
      if (!this.llmProviderConfigs.configs.some((config) => config.id === configId)) return;
      this.llm.activeProviderConfigId = configId;
      this.saveLlm();
    },
    createLlmProviderConfig(name = '新渠道配置', provider: LlmProviderKind = 'openai-compatible'): void {
      const config = createDefaultProviderConfig(name.trim() || '新渠道配置', provider);
      this.llmProviderConfigs.configs.push(config);
      this.llm.activeProviderConfigId = config.id;
      this.pendingActiveProviderConfigIdAfterConfigsSave = config.id;
      this.saveLlmProviderConfigs();
    },
    renameLlmProviderConfig(configId: string, name: string): void {
      const config = this.llmProviderConfigs.configs.find((candidate) => candidate.id === configId);
      if (!config) return;
      config.name = name.trim() || config.name;
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    updateActiveLlmProviderConfig(patch: Partial<LlmProviderConfigRecord>): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      Object.assign(config, patch, { updatedAt: Date.now() });
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmGenerationConfig(generationConfig: LlmGenerationConfigRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.generationConfig = normalizeGenerationConfigForUi(generationConfig) ?? {};
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmRequestBody(requestBody: LlmRequestBodyRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.requestBody = sanitizeRequestBody(requestBody) ?? {};
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmHeaders(headers: LlmProviderHeadersRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.headers = sanitizeHeaders(headers) ?? {};
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    requestModelsForActiveConfig(): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const requestConfig = toPlainProviderConfig(config);
      this.status = '正在获取模型列表...';
      this.fetchedModelsDialog = { open: true, loading: true, configId: requestConfig.id, models: [] };
      try {
        bridge.request(BridgeMessageType.LlmProviderModelsGet, { config: requestConfig });
        startModelFetchTimeout(() => {
          this.status = '获取模型列表超时，请检查 Base URL、API Key 或网络代理设置。';
          this.fetchedModelsDialog = { open: true, loading: false, configId: requestConfig.id, models: [] };
        });
      } catch (error) {
        this.status = `获取模型列表请求发送失败：${error instanceof Error ? error.message : String(error)}`;
        this.closeFetchedModelsDialog();
      }
    },
    closeFetchedModelsDialog(): void {
      this.fetchedModelsDialog = emptyFetchedModelsDialog();
    },
    addFetchedModelsToConfig(models: LlmProviderModelRecord[]): void {
      const configId = this.fetchedModelsDialog.configId;
      const config = this.llmProviderConfigs.configs.find((candidate) => candidate.id === configId);
      const selected = sanitizeModels(models);
      if (!config || selected.length === 0) {
        this.closeFetchedModelsDialog();
        return;
      }
      const selectedIds = new Set(selected.map((model) => model.id));
      config.models = sanitizeModels([
        ...config.models.filter((model) => !selectedIds.has(model.id)),
        ...selected
      ]);
      if (!config.model) config.model = selected[0]?.id ?? '';
      config.updatedAt = Date.now();
      this.status = `已添加 ${selected.length} 个模型`;
      this.closeFetchedModelsDialog();
      this.saveLlmProviderConfigs();
    },
    addModelToActiveConfig(modelId: string, modelName?: string): void {
      const config = this.activeLlmProviderConfig;
      const id = modelId.trim();
      if (!config || !id) return;
      const name = modelName?.trim() || id;
      const models = sanitizeModels([...config.models.filter((model) => model.id !== id), { id, name }]);
      config.models = models;
      config.model = id;
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    selectActiveConfigModel(modelId: string): void {
      const config = this.activeLlmProviderConfig;
      if (!config || !config.models.some((model) => model.id === modelId)) return;
      config.model = modelId;
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    removeModelFromActiveConfig(modelId: string): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.models = config.models.filter((model) => model.id !== modelId);
      if (config.model === modelId) config.model = config.models[0]?.id ?? '';
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    clearModelsFromActiveConfig(): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.models = [];
      config.model = '';
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    deleteLlmProviderConfig(configId: string): void {
      if (this.llmProviderConfigs.configs.length <= 1) {
        this.status = '至少需要保留一个渠道配置';
        return;
      }
      const nextConfigs = this.llmProviderConfigs.configs.filter((config) => config.id !== configId);
      if (nextConfigs.length === this.llmProviderConfigs.configs.length) return;
      this.llmProviderConfigs.configs = nextConfigs;
      if (this.llm.activeProviderConfigId === configId) {
        this.llm.activeProviderConfigId = nextConfigs[0]?.id ?? '';
        this.pendingActiveProviderConfigIdAfterConfigsSave = this.llm.activeProviderConfigId;
      }
      this.saveLlmProviderConfigs();
    },
    applySnapshot(payload: GlobalSettingsSnapshotPayload, correlationId?: string): void {
      const isLlmProviderConfigsSnapshot = payload.section === 'llmProviderConfigs';
      const providerConfigsRequestRevision = isLlmProviderConfigsSnapshot && correlationId
        ? llmProviderConfigsSaveRequestRevisions.get(correlationId)
        : undefined;
      if (providerConfigsRequestRevision !== undefined && correlationId) {
        llmProviderConfigsSaveRequestRevisions.delete(correlationId);
      }

      this.loadedSections[payload.section] = true;
      this.filePaths[payload.section] = payload.filePath;

      if (providerConfigsRequestRevision !== undefined && providerConfigsRequestRevision < llmProviderConfigsEditRevision) {
        if (!hasPendingLlmProviderConfigsSave()) this.clearPendingSettingSection(payload.section);
        if (Object.keys(this.pendingSettingsSections).length === 0) this.status = '设置已同步';
        return;
      }

      if (payload.section === 'llm') {
        this.llm = { ...emptyLlm(), ...(payload.settings as LlmSettingsRecord) };
      } else if (payload.section === 'llmProviderConfigs') {
        const settings = payload.settings as LlmProviderConfigsRecord;
        this.llmProviderConfigs = {
          configs: settings.configs.map(normalizeProviderConfigForUi)
        };
        if (this.pendingActiveProviderConfigIdAfterConfigsSave) {
          const pendingId = this.pendingActiveProviderConfigIdAfterConfigsSave;
          this.pendingActiveProviderConfigIdAfterConfigsSave = '';
          const nextActiveId = this.llmProviderConfigs.configs.some((config) => config.id === pendingId)
            ? pendingId
            : this.llmProviderConfigs.configs[0]?.id ?? '';
          this.llm.activeProviderConfigId = nextActiveId;
          this.saveLlm();
        }
      } else if (payload.section === 'llmCompression') {
        this.llmCompression = { ...emptyLlmCompression(), ...(payload.settings as LlmCompressionSettingsRecord) };
      } else if (payload.section === 'llmCompressionConfigs') {
        const settings = payload.settings as LlmCompressionConfigsRecord;
        this.llmCompressionConfigs = { configs: settings.configs };
      } else if (payload.section === 'checkpointMaintenance') {
        this.checkpointMaintenance = { ...emptyCheckpointMaintenance(), ...(payload.settings as CheckpointMaintenanceSettingsRecord) };
      } else {
        this.common = payload.settings as GlobalSettingsRecord;
      }
      if (!isLlmProviderConfigsSnapshot || !hasPendingLlmProviderConfigsSave()) this.clearPendingSettingSection(payload.section);
      if (Object.keys(this.pendingSettingsSections).length === 0) this.status = '设置已同步';
    },
    applyLlmProviderModelsSnapshot(payload: LlmProviderModelsSnapshotPayload): void {
      clearModelFetchTimeout();
      const config = this.llmProviderConfigs.configs.find((candidate) => candidate.id === payload.configId);
      if (!config) return;
      const models = sanitizeModels(payload.models);
      this.fetchedModelsDialog = { open: true, loading: false, configId: payload.configId, models };
      this.status = models.length ? `已获取 ${models.length} 个模型，请选择要添加的模型` : '没有获取到模型';
    },
    setError(message: string): void {
      clearModelFetchTimeout();
      clearLlmProviderConfigsAutoSaveTimer();
      llmProviderConfigsSaveRequestRevisions.clear();
      this.closeFetchedModelsDialog();
      this.pendingSettingsSections = {};
      this.status = `设置保存失败：${message}`;
    }
  }
});
