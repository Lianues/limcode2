<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconCloudDown, IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-vue';
import {
  DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  type LlmGenerationConfigRecord,
  type LlmProviderConfigRecord,
  type LlmProviderHeadersRecord,
  type LlmProviderKind,
  type LlmCompressionMethodKind,
  type LlmProviderModelRecord,
  type LlmRequestBodyRecord,
  type LlmToolCallFormat
} from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import TokenThresholdSlider from '@webview/components/ui/TokenThresholdSlider.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';
import ModelFetchDialog from './ModelFetchDialog.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';
import LlmHeadersSettings from './parameters/LlmHeadersSettings.vue';
import LlmParameterSettings from './parameters/LlmParameterSettings.vue';

const settings = useGlobalSettingsStore();
const { loading: channelLoading, text: channelLoadingText } = useSettingsLoadingText('渠道配置', 'global', undefined, {
  globalSettingsSections: ['llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs'] as const
});
type SelectableCompressionMethodKind = 'openai_responses_compact' | 'llm_summary' | 'segmented_summary' | 'deterministic_summary';
const TOKEN_STEP = 1_000;
const createOpen = ref(false);
const createProvider = ref<LlmProviderKind>('openai-compatible');
const renameOpen = ref(false);
const deleteConfirmOpen = ref(false);
const newModelOpen = ref(false);
const newModelName = ref('');
const modelFilter = ref('');
const modelListScroller = ref<HTMLElement | null>(null);
const clearModelsConfirmOpen = ref(false);

const providerOptions: SettingsDropdownOption[] = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'deepseek', label: 'DeepSeek' }
];

const toolCallFormatOptions: SettingsDropdownOption[] = [
  { value: 'function-call', label: 'Function Call' }
];

const activeConfig = computed(() => settings.activeLlmProviderConfig);
const canDeleteActiveConfig = computed(() => !!activeConfig.value && settings.llmProviderConfigs.configs.length > 1);
const activeConfigId = computed({
  get: () => settings.llm.activeProviderConfigId || activeConfig.value?.id || '',
  set: (configId: string) => settings.selectLlmProviderConfig(configId)
});
const activeCompressionMethodKind = computed<SelectableCompressionMethodKind>(() => {
  const kind = settings.activeCompressionConfig?.kind ?? 'segmented_summary';
  if (kind === 'openai_responses_compact' && compressionProviderConfig.value?.provider !== 'openai-responses') return 'llm_summary';
  if (kind === 'disabled' || kind === 'manual_summary') return 'llm_summary';
  return kind;
});
const configPageOptions = computed<SettingsDropdownOption[]>(() =>
  settings.llmProviderConfigs.configs.map((config) => ({ value: config.id, label: config.name, description: providerLabel(config.provider) }))
);
const activeProviderLabel = computed(() => providerLabel(activeConfig.value?.provider));
const compressionProviderConfigId = computed({
  get: () => settings.activeCompressionConfig?.openaiResponsesCompact?.providerConfigId
    ?? settings.activeCompressionConfig?.llmSummary?.providerConfigId
    ?? '__current__',
  set: (configId: string) => settings.setActiveCompressionProviderConfig(configId === '__current__' ? '' : configId)
});
const compressionProviderConfig = computed(() => {
  const id = compressionProviderConfigId.value;
  return id === '__current__'
    ? activeConfig.value
    : settings.llmProviderConfigs.configs.find((config) => config.id === id) ?? activeConfig.value;
});
const compressionProviderOptions = computed<SettingsDropdownOption[]>(() => [
  { value: '__current__', label: '跟随当前渠道', description: activeConfig.value ? `${activeConfig.value.name} · ${providerLabel(activeConfig.value.provider)}` : '使用当前聊天渠道' },
  ...settings.llmProviderConfigs.configs.map((config) => ({ value: config.id, label: config.name, description: config.model ? `${providerLabel(config.provider)} · ${config.model}` : providerLabel(config.provider) }))
]);
const compressionMethodOptions = computed<SettingsDropdownOption[]>(() => {
  const base: SettingsDropdownOption[] = [
    { value: 'segmented_summary', label: '分段总结拼接' },
    { value: 'llm_summary', label: 'LLM 总结' },
    { value: 'deterministic_summary', label: '确定性摘要' }
  ];
  if (compressionProviderConfig.value?.provider === 'openai-responses') {
    base.splice(2, 0, { value: 'openai_responses_compact', label: 'OpenAI 原生压缩' });
  }
  return base;
});
const filteredModels = computed<LlmProviderModelRecord[]>(() => {
  const keyword = modelFilter.value.trim().toLowerCase();
  const models = activeConfig.value?.models ?? [];
  if (!keyword) return models;
  return models.filter((model) => {
    return model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword);
  });
});
const contextWindowTokens = computed(() => normalizeTokenCount(activeConfig.value?.contextWindowTokens) ?? 0);
const activeCompressionTrigger = computed(() => settings.activeCompressionConfig?.trigger);
const compressionAutoEnabled = computed(() => (activeCompressionTrigger.value?.mode ?? 'token_threshold') === 'token_threshold');
const compressionReserveTokens = computed(() => normalizeTokenCount(activeCompressionTrigger.value?.reserveLatestUserMessageTokens) ?? DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS);
const configuredThresholdPercent = computed(() => clampPercent(activeCompressionTrigger.value?.thresholdPercent ?? 80));
const compressionThresholdTokens = computed(() => {
  const contextWindow = contextWindowTokens.value;
  const tokenValue = normalizeTokenCount(activeCompressionTrigger.value?.thresholdTokens);
  if (tokenValue !== undefined) return contextWindow > 0 ? Math.min(tokenValue, contextWindow) : tokenValue;
  if (contextWindow <= 0) return 0;
  return clampTokenToContext((contextWindow * configuredThresholdPercent.value) / 100, contextWindow);
});
const compressionThresholdPercent = computed(() => {
  const contextWindow = contextWindowTokens.value;
  const thresholdTokens = compressionThresholdTokens.value;
  if (contextWindow > 0 && thresholdTokens > 0) return clampPercent((thresholdTokens / contextWindow) * 100);
  return configuredThresholdPercent.value;
});
const recommendedThresholdTokens = computed(() => {
  const contextWindow = contextWindowTokens.value;
  if (contextWindow <= 0) return 0;
  return clampTokenToContext(contextWindow - compressionReserveTokens.value, contextWindow);
});
const compressionThresholdInputValue = computed(() => String(compressionThresholdTokens.value || ''));


const hasModels = computed(() => (activeConfig.value?.models.length ?? 0) > 0);
const canClearModels = computed(() => !!activeConfig.value && hasModels.value);

/** 获取模型弹窗对应配置中已存在的模型 ID，用于在弹窗中标记「已添加」状态。 */
const fetchedDialogExistingModelIds = computed<string[]>(() => {
  const configId = settings.fetchedModelsDialog.configId;
  const config = settings.llmProviderConfigs.configs.find((c) => c.id === configId);
  return config?.models.map((m) => m.id) ?? [];
});

function formatModelTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}


function updateActiveConfigField<K extends keyof LlmProviderConfigRecord>(key: K, value: LlmProviderConfigRecord[K]): void {
  settings.updateActiveLlmProviderConfig({ [key]: value } as Partial<LlmProviderConfigRecord>);
}
function normalizeTokenCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function alignTokenCountToK(value: number): number {
  return Math.max(TOKEN_STEP, Math.round(value / TOKEN_STEP) * TOKEN_STEP);
}

function clampTokenToContext(value: number, contextWindow = contextWindowTokens.value): number {
  const aligned = alignTokenCountToK(value);
  return contextWindow > 0 ? Math.min(contextWindow, aligned) : aligned;
}

function clampPercent(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(100, Math.max(1, number));
}

function percentForTokens(tokens: number, contextWindow = contextWindowTokens.value): number {
  return contextWindow > 0 ? clampPercent((tokens / contextWindow) * 100) : compressionThresholdPercent.value;
}

function formatTokenLabel(value: number | undefined): string {
  const tokens = normalizeTokenCount(value);
  if (tokens === undefined) return '未设置';
  const kilo = tokens / 1_000;
  if (kilo >= 1) return `${Number.isInteger(kilo) ? kilo.toFixed(0) : kilo.toFixed(1)}k`;
  return `${tokens}`;
}

function numericInputValue(event: Event): number | undefined {
  const value = (event.target as HTMLInputElement).value.trim();
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function updateContextWindowTokens(event: Event): void {
  const value = numericInputValue(event);
  settings.updateActiveLlmContextWindowTokens(value === undefined ? undefined : alignTokenCountToK(value));
}

function normalizeRetryMaxAttempts(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
  const attempts = Math.floor(number);
  return attempts < -1 ? -1 : attempts;
}

function updateRetryMaxAttempts(event: Event): void {
  updateActiveConfigField('retryMaxAttempts', normalizeRetryMaxAttempts(numericInputValue(event)));
}

function updateCompressionAutoEnabled(enabled: boolean): void {
  settings.updateActiveCompressionTrigger({ mode: enabled ? 'token_threshold' : 'manual' });
}

function updateCompressionThresholdTokens(event: Event): void {
  const value = numericInputValue(event);
  if (value === undefined) return;
  updateCompressionThresholdFromTokens(value);
}

function updateCompressionThresholdFromTokens(value: number): void {
  const tokens = clampTokenToContext(value);
  settings.updateActiveCompressionTrigger({
    thresholdUnit: 'tokens',
    thresholdTokens: tokens,
    thresholdPercent: percentForTokens(tokens)
  });
}



function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function updateGenerationConfig(value: LlmGenerationConfigRecord | undefined): void {
  settings.updateActiveLlmGenerationConfig(value);
}

function updateRequestBody(value: LlmRequestBodyRecord | undefined): void {
  settings.updateActiveLlmRequestBody(value);
}

function updateHeaders(value: LlmProviderHeadersRecord | undefined): void {
  settings.updateActiveLlmHeaders(value);
}

function providerLabel(provider: LlmProviderKind | undefined): string {
  return providerOptions.find((option) => option.value === provider)?.label ?? '未知渠道';
}

function compressionKindLabel(kind: LlmCompressionMethodKind | undefined): string {
  switch (kind) {
    case 'openai_responses_compact': return 'OpenAI 原生压缩';
    case 'llm_summary': return 'LLM 总结';
    case 'segmented_summary': return '分段总结拼接';
    case 'deterministic_summary': return '确定性摘要';
    case 'manual_summary': return '手动摘要';
    case 'disabled': return '关闭';
    default: return '未知方法';
  }
}

function updateActiveCompressionMethod(value: string): void {
  settings.setActiveCompressionMethodKind(value as SelectableCompressionMethodKind);
}


function openCreate(): void {
  createProvider.value = 'openai-compatible';
  createOpen.value = true;
}

function confirmCreate(name: string): void {
  createOpen.value = false;
  settings.createLlmProviderConfig(name, createProvider.value);
}

function cancelCreate(): void {
  createOpen.value = false;
}

function updateCreateProvider(value: string): void {
  createProvider.value = value as LlmProviderKind;
}

function openNewModel(): void {
  newModelName.value = '';
  newModelOpen.value = true;
}

function confirmNewModel(modelId: string): void {
  newModelOpen.value = false;
  settings.addModelToActiveConfig(modelId, newModelName.value);
  newModelName.value = '';
}

function cancelNewModel(): void {
  newModelOpen.value = false;
  newModelName.value = '';
}

function updateNewModelName(event: Event): void {
  newModelName.value = (event.target as HTMLInputElement).value;
}

function openClearModelsConfirm(): void {
  if (!canClearModels.value) return;
  clearModelsConfirmOpen.value = true;
}

function confirmClearModels(): void {
  clearModelsConfirmOpen.value = false;
  settings.clearModelsFromActiveConfig();
}

function cancelClearModels(): void {
  clearModelsConfirmOpen.value = false;
}

function removeModel(modelId: string): void {
  settings.removeModelFromActiveConfig(modelId);
}

function openRename(): void {
  if (!activeConfig.value) return;
  renameOpen.value = true;
}

function confirmRename(name: string): void {
  const config = activeConfig.value;
  renameOpen.value = false;
  if (!config) return;
  settings.renameLlmProviderConfig(config.id, name);
}

function cancelRename(): void {
  renameOpen.value = false;
}

function openDeleteConfirm(): void {
  if (!canDeleteActiveConfig.value) return;
  deleteConfirmOpen.value = true;
}

function confirmDelete(): void {
  const config = activeConfig.value;
  deleteConfirmOpen.value = false;
  if (!config) return;
  settings.deleteLlmProviderConfig(config.id);
}

function addFetchedModels(models: LlmProviderModelRecord[]): void {
  settings.addFetchedModelsToConfig(models);
}

function cancelDelete(): void {
  deleteConfirmOpen.value = false;
}
</script>

<template>
  <section class="global-settings-tab-section" aria-label="渠道设置">
    <header class="global-settings-section-header">
      <div>
        <div class="channel-title-row">
          <h2>渠道</h2>
          <SettingsLoadingInline
            :show="channelLoading"
            :text="channelLoadingText"
          />
        </div>
        <p>配置全局范围内可复用的 LLM 渠道。后续 Agent、Mode 或其他对象可通过关系数据复用这些配置。</p>
      </div>
    </header>

    <div class="channel-content-shell">
      <div class="channel-content" :aria-busy="channelLoading">
        <div class="channel-config-picker">
      <label class="global-settings-field channel-config-select">
        <span>配置页</span>
        <SettingsDropdown
          v-model="activeConfigId"
          :options="configPageOptions"
          title="切换配置页"
          empty-text="暂无渠道配置。"
          searchable
          search-placeholder="筛选配置页..."
        />
      </label>

      <div class="channel-config-actions" aria-label="渠道配置页操作">
        <button type="button" class="icon-action" aria-label="新建配置页" @click="openCreate">
          <IconPlus stroke="2" aria-hidden="true" />
        </button>
        <button type="button" class="icon-action" aria-label="重命名配置页" :disabled="!activeConfig" @click="openRename">
          <IconPencil stroke="2" aria-hidden="true" />
        </button>
        <button type="button" class="icon-action" aria-label="删除配置页" :disabled="!canDeleteActiveConfig" @click="openDeleteConfirm">
          <IconTrash stroke="2" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="activeConfig" class="global-settings-grid">
      <label class="global-settings-field">
        <span>渠道类型</span>
        <input :value="activeProviderLabel" type="text" readonly />
      </label>

      <label class="global-settings-field">
        <span>工具调用格式</span>
        <SettingsDropdown
          :model-value="activeConfig.toolCallFormat"
          :options="toolCallFormatOptions"
          title="选择工具调用格式"
          @update:model-value="updateActiveConfigField('toolCallFormat', $event as LlmToolCallFormat)"
        />
      </label>

      <label class="global-settings-field global-settings-field-wide">
        <span>Base URL</span>
        <input :value="activeConfig.baseUrl" type="text" placeholder="https://api.openai.com/v1" @input="updateActiveConfigField('baseUrl', inputValue($event))" />
      </label>

      <label class="global-settings-field global-settings-api-key-field global-settings-field-wide">
        <span>API Key</span>
        <input :value="activeConfig.apiKey" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false" @input="updateActiveConfigField('apiKey', inputValue($event))" />
      </label>

      <label class="global-settings-field context-window-field">
        <span>上下文窗口 token 数</span>
        <input
          class="token-number-input"
          :value="activeConfig.contextWindowTokens ?? ''"
          type="number"
          min="1000"
          :step="TOKEN_STEP"
          placeholder="例如 200000"
          @change="updateContextWindowTokens"
        />
      </label>

      <div class="global-settings-field stream-field">
        <span>流式生成</span>
        <div class="stream-checkbox-row">
          <LcCheckbox
            :model-value="activeConfig.stream !== false"
            size="sm"
            aria-label="启用流式生成"
            @update:model-value="updateActiveConfigField('stream', $event)"
          >
            <span class="stream-checkbox-enable">启用</span>
          </LcCheckbox>
        </div>
        <span class="stream-checkbox-text">启用流式生成。普通回复和上下文压缩会复用此配置。</span>
      </div>

      <div class="global-settings-field stream-field retry-field">
        <span>报错自动重试</span>
        <div class="stream-checkbox-row">
          <LcCheckbox
            :model-value="activeConfig.retryOnError ?? DEFAULT_LLM_RETRY_ON_ERROR"
            size="sm"
            aria-label="启用报错自动重试"
            @update:model-value="updateActiveConfigField('retryOnError', $event)"
          >
            <span class="stream-checkbox-enable">启用</span>
          </LcCheckbox>
        </div>
        <span class="stream-checkbox-text">请求报错时自动重试。重试次数不包含原始请求；设置为 -1 表示无限重试。</span>
      </div>

      <label class="global-settings-field retry-attempts-field">
        <span>最大重试次数</span>
        <input
          class="token-number-input"
          :value="activeConfig.retryMaxAttempts ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS"
          type="number"
          min="-1"
          step="1"
          placeholder="3"
          @change="updateRetryMaxAttempts"
        />
      </label>

      <section class="model-manager global-settings-field-wide" aria-label="模型列表">
        <header class="model-manager-header">
          <label>模型列表</label>
          <div class="model-manager-actions">
            <button type="button" class="model-manager-button" @click="openNewModel">
              <IconPlus stroke="2" aria-hidden="true" />
              <span>新建模型</span>
            </button>
            <button type="button" class="model-manager-button" @click="settings.requestModelsForActiveConfig()">
              <IconCloudDown stroke="2" aria-hidden="true" />
              <span>获取模型</span>
            </button>
            <button type="button" class="model-manager-button" :disabled="!canClearModels" @click="openClearModelsConfirm">
              <IconTrash stroke="2" aria-hidden="true" />
              <span>清除全部</span>
            </button>
          </div>
        </header>

        <div class="model-list-container">
          <label class="model-filter-box" aria-label="筛选模型">
            <IconSearch stroke="2" aria-hidden="true" />
            <input v-model="modelFilter" type="text" placeholder="筛选模型..." />
          </label>

          <div class="model-list-shell">
            <div ref="modelListScroller" class="model-list-scroll">
              <div class="model-list">
                <div v-if="!hasModels" class="model-list-empty">暂无模型，请新建模型。</div>
                <div v-else-if="!filteredModels.length" class="model-list-empty">没有匹配的模型。</div>
                <div
                  v-for="model in filteredModels"
                  :key="model.id"
                  class="model-item"
                  :class="{ enabled: model.id === activeConfig.model }"
                  role="button"
                  tabindex="0"
                  @click="settings.selectActiveConfigModel(model.id)"
                  @keydown.enter.prevent="settings.selectActiveConfigModel(model.id)"
                  @keydown.space.prevent="settings.selectActiveConfigModel(model.id)"
                >
                  <span class="model-status" aria-hidden="true"></span>
                  <span class="model-info">
                    <span class="model-name">{{ model.name }}</span>
                    <span class="model-id">ID: {{ model.id }}</span>
                    <span v-if="model.createdAt" class="model-time">时间: {{ formatModelTime(model.createdAt) }}</span>
                  </span>
                  <button
                    type="button"
                    class="model-remove-btn"
                    aria-label="移除模型"
                    @click.stop="removeModel(model.id)"
                    @keydown.enter.stop.prevent="removeModel(model.id)"
                    @keydown.space.stop.prevent="removeModel(model.id)"
                  ><IconTrash stroke="2" aria-hidden="true" /></button>
                </div>
              </div>
            </div>
            <AdvancedScrollbar :scroller="modelListScroller" variant="minimal" />
          </div>
        </div>
      </section>

      <section class="compression-settings global-settings-field-wide" aria-label="上下文压缩">
        <header class="compression-settings-header">
          <div>
            <label>上下文压缩</label>
            <p>选择当前渠道使用的压缩方式。非 OpenAI Responses 渠道不会显示 OpenAI 原生压缩。</p>
          </div>
        </header>
        <div class="global-settings-grid compression-settings-grid">
          <label class="global-settings-field">
            <span>压缩渠道</span>
            <SettingsDropdown
              v-model="compressionProviderConfigId"
              :options="compressionProviderOptions"
              title="选择压缩使用的渠道配置"
              searchable
              search-placeholder="筛选渠道..."
            />
          </label>
          <label class="global-settings-field">
            <span>压缩方法</span>
            <SettingsDropdown
              :model-value="activeCompressionMethodKind"
              :options="compressionMethodOptions"
              title="选择压缩方法"
              @update:model-value="updateActiveCompressionMethod"
            />
          </label>

          <label class="global-settings-field global-settings-field-wide compression-auto-field">
            <span>自动触发</span>
            <LcCheckbox
              :model-value="compressionAutoEnabled"
              aria-label="启用自动触发上下文压缩"
              @update:model-value="updateCompressionAutoEnabled"
            >
              <span class="compression-auto-text">启用后，当上下文达到阈值时自动准备压缩。默认建议开启。</span>
            </LcCheckbox>
          </label>

          <div v-if="compressionAutoEnabled" class="compression-trigger-panel global-settings-field-wide">
            <div class="compression-trigger-head">
              <div>
                <span class="compression-trigger-title">触发上下文 token 数阈值</span>
                <p>直接填写触发压缩的上下文 token 数；建议至少预留 {{ formatTokenLabel(compressionReserveTokens) }} 窗口给最后一轮用户消息。</p>
              </div>
            </div>

            <div class="compression-threshold-control">
              <label class="global-settings-field compression-threshold-input-field">
                <span>上下文 token 数</span>
                <span class="threshold-input-shell">
                  <input
                    class="token-number-input"
                    :value="compressionThresholdInputValue"
                    type="number"
                    :min="TOKEN_STEP"
                    :max="contextWindowTokens || undefined"
                    :step="TOKEN_STEP"
                    :disabled="contextWindowTokens <= 0"
                    @change="updateCompressionThresholdTokens"
                  />
                  <span>token</span>
                </span>
              </label>

              <TokenThresholdSlider
                :model-value="compressionThresholdTokens"
                :max-tokens="contextWindowTokens"
                :step-tokens="TOKEN_STEP"
                :recommended-tokens="recommendedThresholdTokens"
                :disabled="contextWindowTokens <= 0"
                aria-label="拖拽调整自动压缩触发阈值"
                @update:model-value="updateCompressionThresholdFromTokens"
              />
            </div>
          </div>
        </div>
      </section>

      <LlmParameterSettings
        class="global-settings-field-wide"
        :config="activeConfig"
        @update-generation-config="updateGenerationConfig"
        @update-request-body="updateRequestBody"
      />

      <LlmHeadersSettings
        class="global-settings-field-wide"
        :model-value="activeConfig.headers ?? {}"
        @update:model-value="updateHeaders"
      />
    </div>

    <div v-else class="global-settings-empty">暂无渠道配置，请新建一个配置页。</div>

    <div class="global-settings-actions">
      <button type="button" class="secondary" @click="settings.requestAll()">重新读取</button>
      <span class="global-settings-status">{{ settings.status || '渠道配置会自动保存' }}</span>
    </div>

    <div class="global-settings-path-list" aria-label="渠道配置路径信息">
      <p class="global-settings-path">
        当前配置选择：<code>{{ settings.filePaths.llm || '等待后端返回 settings/llm.json 路径...' }}</code>
      </p>
      <p class="global-settings-path">
        渠道配置页：<code>{{ settings.filePaths.llmProviderConfigs || '等待后端返回 settings/llm-provider-configs/index.json 路径...' }}</code>
      </p>
    </div>
      </div>
    </div>

    <InputPanel
      :open="createOpen"
      title="新建配置页"
      label="配置页名称"
      initial-value="新渠道配置"
      placeholder="输入配置页名称"
      confirm-label="新建"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    >
      <label class="global-settings-field create-channel-provider-field">
        <span>渠道类型</span>
        <SettingsDropdown :model-value="createProvider" :options="providerOptions" title="选择渠道类型" @update:model-value="updateCreateProvider" />
      </label>
    </InputPanel>

    <InputPanel
      :open="newModelOpen"
      title="新建模型"
      label="模型 ID"
      initial-value=""
      placeholder="输入模型 ID"
      confirm-label="添加模型"
      @confirm="confirmNewModel"
      @cancel="cancelNewModel"
    >
      <label class="global-settings-field create-model-name-field">
        <span>模型名称（可选）</span>
        <input :value="newModelName" type="text" placeholder="不填则与模型 ID 相同" @input="updateNewModelName" />
      </label>
    </InputPanel>


    <InputPanel
      :open="renameOpen"
      title="重命名配置页"
      label="配置页名称"
      :initial-value="activeConfig?.name ?? ''"
      placeholder="输入配置页名称"
      confirm-label="保存名称"
      @confirm="confirmRename"
      @cancel="cancelRename"
    />

    <ConfirmPanel
      :open="clearModelsConfirmOpen"
      title="清除全部模型？"
      description-html="将清除当前配置页下的所有模型，并取消当前使用模型，此操作<strong>无法撤销</strong>。"
      confirm-label="清除全部"
      cancel-label="取消"
      @confirm="confirmClearModels"
      @cancel="cancelClearModels"
    />


    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除配置页？"
      :description-html="`将删除「${activeConfig?.name ?? '当前配置'}」这个渠道配置页，此操作<strong>无法撤销</strong>。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ModelFetchDialog
      :open="settings.fetchedModelsDialog.open"
      :loading="settings.fetchedModelsDialog.loading"
      :models="settings.fetchedModelsDialog.models"
      :existing-model-ids="fetchedDialogExistingModelIds"
      @add="addFetchedModels"
      @close="settings.closeFetchedModelsDialog()"
    />
  </section>
</template>

<style scoped>
.compression-settings {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
}

.compression-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.compression-settings-header p {
  margin: 2px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.compression-settings-grid {
  margin: 0;
}

.stream-field {
  justify-content: start;
}

.stream-checkbox-row {
  min-height: 20px;
  display: flex;
  align-items: center;
}

.stream-checkbox-row :deep(.lc-checkbox-control) {
  align-items: center;
}

.stream-checkbox-row :deep(.lc-checkbox-box) {
  flex: 0 0 auto;
}

.stream-checkbox-enable {
  color: var(--vscode-foreground);
  font-size: var(--font-size-xs);
  line-height: 1.2;
}

.stream-checkbox-text,
.compression-auto-text {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.token-number-input[type='number'] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.token-number-input[type='number']::-webkit-outer-spin-button,
.token-number-input[type='number']::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.compression-auto-field {
  padding-top: var(--space-1);
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
}

.compression-trigger-panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.compression-trigger-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
}

.compression-trigger-title {
  display: block;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.compression-trigger-head p {
  margin: 3px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}


.compression-threshold-control {
  display: grid;
  grid-template-columns: minmax(130px, 190px) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
}

.compression-threshold-input-field {
  min-width: 0;
}

.threshold-input-shell {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
}

.threshold-input-shell input {
  min-width: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.threshold-input-shell input:focus {
  outline: none;
}

.threshold-input-shell > span {
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
}


@media (max-width: 720px) {
  .compression-trigger-head,
  .compression-threshold-control {
    grid-template-columns: 1fr;
  }

  .compression-trigger-head {
    display: grid;
  }
}
</style>

