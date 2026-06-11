<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-vue';
import type { LlmProviderConfigRecord, LlmProviderKind, LlmToolCallFormat } from '@shared/protocol';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';

const settings = useGlobalSettingsStore();
const createOpen = ref(false);
const createProvider = ref<LlmProviderKind>('deepseek');
const renameOpen = ref(false);
const deleteConfirmOpen = ref(false);

const providerOptions: SettingsDropdownOption[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' }
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
  settings.llmProviderConfigs.configs.map((config) => ({ value: config.id, label: config.name }))
);
const activeProviderLabel = computed(() => providerLabel(activeConfig.value?.provider));

function updateActiveConfigField<K extends keyof LlmProviderConfigRecord>(key: K, value: LlmProviderConfigRecord[K]): void {
  settings.updateActiveLlmProviderConfig({ [key]: value } as Partial<LlmProviderConfigRecord>);
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function providerLabel(provider: LlmProviderKind | undefined): string {
  return providerOptions.find((option) => option.value === provider)?.label ?? '未知渠道';
}

function openCreate(): void {
  createProvider.value = 'deepseek';
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

function cancelDelete(): void {
  deleteConfirmOpen.value = false;
}
</script>

<template>
  <section class="global-settings-tab-section" aria-label="渠道设置">
    <header class="global-settings-section-header">
      <div>
        <h2>渠道</h2>
        <p>配置全局范围内可复用的 LLM 渠道。后续 Agent、Mode 或其他对象可通过关系数据复用这些配置。</p>
      </div>
    </header>

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
        <input :value="activeConfig.baseUrl" type="text" placeholder="https://api.deepseek.com/v1" @input="updateActiveConfigField('baseUrl', inputValue($event))" />
      </label>

      <label class="global-settings-field global-settings-api-key-field global-settings-field-wide">
        <span>API Key</span>
        <input :value="activeConfig.apiKey" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false" @input="updateActiveConfigField('apiKey', inputValue($event))" />
      </label>

      <label class="global-settings-field">
        <span>模型名称</span>
        <input :value="activeConfig.model" type="text" placeholder="deepseek-v4-flash" @input="updateActiveConfigField('model', inputValue($event))" />
      </label>
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
      :open="deleteConfirmOpen"
      title="删除配置页？"
      :description-html="`将删除「${activeConfig?.name ?? '当前配置'}」这个渠道配置页，此操作<strong>无法撤销</strong>。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>
