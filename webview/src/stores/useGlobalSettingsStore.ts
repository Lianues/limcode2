import { defineStore } from 'pinia';
import {
  GLOBAL_SETTINGS_SECTIONS,
  createMessageId,
  type GlobalSettingsRecord,
  type GlobalSettingsSection,
  type GlobalSettingsSnapshotPayload,
  type LlmProviderKind,
  type LlmProviderConfigRecord,
  type LlmProviderModelRecord,
  type LlmProviderConfigsRecord,
  type LlmSettingsRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

interface GlobalSettingsState {
  common: GlobalSettingsRecord;
  /** LLM 全局选择信息：只保存当前激活的可复用渠道配置 id。 */
  llm: LlmSettingsRecord;
  /** 全局范围内可复用的渠道配置集合。 */
  llmProviderConfigs: LlmProviderConfigsRecord;
  /** 各 section 的来源文件路径，用于在 UI 展示。 */
  filePaths: Partial<Record<GlobalSettingsSection, string>>;
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

function createDefaultProviderConfig(name = '新渠道配置', provider: LlmProviderKind = 'openai-compatible'): LlmProviderConfigRecord {
  const now = Date.now();
  return {
    id: `llm-provider-config-${createMessageId()}`,
    name,
    provider,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
    apiKey: '',
    toolCallFormat: 'function-call',
    proxy: '',
    createdAt: now,
    updatedAt: now
  };
}

function normalizeProviderConfigForUi(config: LlmProviderConfigRecord): LlmProviderConfigRecord {
  const model = config.model?.trim() ?? '';
  return { ...config, model, models: normalizeModelsForUi(config.models, model), proxy: config.proxy ?? '' };
}

function normalizeModelsForUi(models: LlmProviderModelRecord[] | undefined, activeModel: string): LlmProviderModelRecord[] {
  const byId = new Map<string, LlmProviderModelRecord>();
  for (const item of models ?? []) {
    const id = item.id.trim();
    if (!id) continue;
    const name = item.name.trim() || id;
    byId.set(id, { id, name });
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
    byId.set(id, { id, name });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** 全局设置（数据目录 + LLM 渠道配置）表单 store。组件只读 state + 调 action，传输细节收口在此。 */
export const useGlobalSettingsStore = defineStore('globalSettings', {
  state: (): GlobalSettingsState => ({
    common: emptyCommon(),
    llm: emptyLlm(),
    llmProviderConfigs: emptyLlmProviderConfigs(),
    filePaths: {},
    status: ''
  }),
  getters: {
    activeLlmProviderConfig(state): LlmProviderConfigRecord | undefined {
      return state.llmProviderConfigs.configs.find((config) => config.id === state.llm.activeProviderConfigId)
        ?? state.llmProviderConfigs.configs[0];
    }
  },
  actions: {
    requestAll(): void {
      this.status = '正在读取设置...';
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
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
      this.status = '正在保存当前渠道选择...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'llm',
        settings: {
          activeProviderConfigId: this.llm.activeProviderConfigId
        }
      });
    },
    saveLlmProviderConfigs(): void {
      this.status = '正在保存渠道配置...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'llmProviderConfigs',
        settings: {
          configs: this.llmProviderConfigs.configs.map((config) => ({
            ...config,
            name: config.name.trim() || '未命名渠道',
            apiKey: config.apiKey.trim(),
            baseUrl: config.baseUrl.trim(),
            models: sanitizeModels(config.models),
            model: config.model.trim(),
            ...(config.proxy?.trim() ? { proxy: config.proxy.trim() } : { proxy: undefined }),
            updatedAt: Date.now()
          }))
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
      this.saveLlmProviderConfigs();
      this.saveLlm();
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
        this.saveLlm();
      }
      this.saveLlmProviderConfigs();
    },
    applySnapshot(payload: GlobalSettingsSnapshotPayload): void {
      if (payload.section === 'llm') {
        this.llm = { ...emptyLlm(), ...(payload.settings as LlmSettingsRecord) };
      } else if (payload.section === 'llmProviderConfigs') {
        const settings = payload.settings as LlmProviderConfigsRecord;
        this.llmProviderConfigs = {
          configs: settings.configs.map(normalizeProviderConfigForUi)
        };
      } else {
        this.common = payload.settings as GlobalSettingsRecord;
      }
      this.filePaths[payload.section] = payload.filePath;
      this.status = '设置已同步';
    },
    setError(message: string): void {
      this.status = `设置保存失败：${message}`;
    }
  }
});
