import { defineStore } from 'pinia';
import {
  GLOBAL_SETTINGS_SECTIONS,
  createMessageId,
  type GlobalSettingsRecord,
  type GlobalSettingsSection,
  type GlobalSettingsSnapshotPayload,
  type LlmGenerationConfigRecord,
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
import { bridge, BridgeMessageType } from '@webview/transport';

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
    ...(config.proxy?.trim() ? { proxy: config.proxy.trim() } : {}),
    ...(sanitizeHeaders(config.headers) ? { headers: sanitizeHeaders(config.headers) } : {}),
    ...(sanitizeGenerationConfig(config.generationConfig) ? { generationConfig: sanitizeGenerationConfig(config.generationConfig) } : {}),
    ...(sanitizeRequestBody(config.requestBody) ? { requestBody: sanitizeRequestBody(config.requestBody) } : {}),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

let modelFetchTimeout: number | undefined;

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
    isChannelSettingsLoading(state): boolean {
      return !state.loadedSections.llm
        || !state.loadedSections.llmProviderConfigs
        || !!state.pendingSettingsSections.llm
        || !!state.pendingSettingsSections.llmProviderConfigs;
    },
    channelSettingsLoadingText(state): string {
      if (!state.loadedSections.llm || !state.loadedSections.llmProviderConfigs) return '正在加载渠道配置...';
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
      this.status = '正在读取设置...';
      this.loadedSections = {};
      this.pendingSettingsSections = {};
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        this.markPendingSettingSection(section);
        bridge.request(BridgeMessageType.GlobalSettingsGet, { section });
      }
    },
    requestChannelSettings(): void {
      for (const section of ['llm', 'llmProviderConfigs'] as const) {
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
    saveLlmProviderConfigs(): void {
      this.markPendingSettingSection('llmProviderConfigs');
      this.status = '正在保存渠道配置...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
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
    },
    updateActiveLlmGenerationConfig(generationConfig: LlmGenerationConfigRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.generationConfig = normalizeGenerationConfigForUi(generationConfig) ?? {};
      config.updatedAt = Date.now();
    },
    updateActiveLlmRequestBody(requestBody: LlmRequestBodyRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.requestBody = sanitizeRequestBody(requestBody) ?? {};
      config.updatedAt = Date.now();
    },
    updateActiveLlmHeaders(headers: LlmProviderHeadersRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.headers = sanitizeHeaders(headers) ?? {};
      config.updatedAt = Date.now();
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
    applySnapshot(payload: GlobalSettingsSnapshotPayload): void {
      this.loadedSections[payload.section] = true;
      this.clearPendingSettingSection(payload.section);
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
      } else {
        this.common = payload.settings as GlobalSettingsRecord;
      }
      this.filePaths[payload.section] = payload.filePath;
      this.status = '设置已同步';
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
      this.closeFetchedModelsDialog();
      this.pendingSettingsSections = {};
      this.status = `设置保存失败：${message}`;
    }
  }
});
