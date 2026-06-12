<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconCloudDown, IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-vue';
import type {
  LlmGenerationConfigRecord,
  LlmProviderConfigRecord,
  LlmProviderKind,
  LlmProviderModelRecord,
  LlmRequestBodyRecord,
  LlmToolCallFormat
} from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import ModelFetchDialog from './ModelFetchDialog.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';
import LlmParameterSettings from './parameters/LlmParameterSettings.vue';

const settings = useGlobalSettingsStore();
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
const configPageOptions = computed<SettingsDropdownOption[]>(() =>
  settings.llmProviderConfigs.configs.map((config) => ({ value: config.id, label: config.name, description: providerLabel(config.provider) }))
);
const activeProviderLabel = computed(() => providerLabel(activeConfig.value?.provider));
const filteredModels = computed<LlmProviderModelRecord[]>(() => {
  const keyword = modelFilter.value.trim().toLowerCase();
  const models = activeConfig.value?.models ?? [];
  if (!keyword) return models;
  return models.filter((model) => {
    return model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword);
  });
});
const hasModels = computed(() => (activeConfig.value?.models.length ?? 0) > 0);
const canClearModels = computed(() => !!activeConfig.value && hasModels.value);

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

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function updateGenerationConfig(value: LlmGenerationConfigRecord | undefined): void {
  settings.updateActiveLlmGenerationConfig(value);
}

function updateRequestBody(value: LlmRequestBodyRecord | undefined): void {
  settings.updateActiveLlmRequestBody(value);
}

function providerLabel(provider: LlmProviderKind | undefined): string {
  return providerOptions.find((option) => option.value === provider)?.label ?? '未知渠道';
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
          <Transition name="channel-loading-fade">
            <span v-if="settings.isChannelSettingsLoading" class="channel-loading-inline" role="status" aria-live="polite">
              <span class="channel-loading-spinner" aria-hidden="true"></span>
              <span>{{ settings.channelSettingsLoadingText }}</span>
            </span>
          </Transition>
        </div>
        <p>配置全局范围内可复用的 LLM 渠道。后续 Agent、Mode 或其他对象可通过关系数据复用这些配置。</p>
      </div>
    </header>

    <div class="channel-content-shell">
      <div class="channel-content" :aria-busy="settings.isChannelSettingsLoading">
        <div class="channel-config-picker">
      <label class="global-settings-field channel-config-select">
        <span>配置页</span>
        <SettingsDropdown
          v-model="activeConfigId"
          :options="configPageOptions"
          title="切换配置页"
          empty-text="暂无渠道配置。"
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

      <LlmParameterSettings
        class="global-settings-field-wide"
        :config="activeConfig"
        @update-generation-config="updateGenerationConfig"
        @update-request-body="updateRequestBody"
      />

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
    </div>

    <div v-else class="global-settings-empty">暂无渠道配置，请新建一个配置页。</div>

    <div class="global-settings-actions">
      <button type="button" :disabled="!activeConfig" @click="settings.saveLlmProviderConfigs()">保存渠道配置</button>
      <button type="button" class="secondary" @click="settings.requestAll()">重新读取</button>
      <span class="global-settings-status">{{ settings.status }}</span>
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
      @add="addFetchedModels"
      @close="settings.closeFetchedModelsDialog()"
    />
  </section>
</template>
