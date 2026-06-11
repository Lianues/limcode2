<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconCaretUp, IconPencil, IconPlus, IconTrash } from '@tabler/icons-vue';
import type { LlmProviderConfigRecord, LlmProviderKind } from '@shared/protocol';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

const settings = useGlobalSettingsStore();
const renameOpen = ref(false);
const deleteConfirmOpen = ref(false);
const configDropdownRoot = ref<HTMLElement | null>(null);
const configDropdownOpen = ref(false);

const providerOptions: Array<{ value: LlmProviderKind; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai-compatible', label: 'OAI 兼容' },
  { value: 'openai-responses', label: 'OAI Response' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' }
];

const toolCallFormatOptions = [
  { value: 'function-call', label: 'Function Call' }
] as const;

const activeConfig = computed(() => settings.activeLlmProviderConfig);
const canDeleteActiveConfig = computed(() => !!activeConfig.value && settings.llmProviderConfigs.configs.length > 1);
const activeConfigId = computed({
  get: () => settings.llm.activeProviderConfigId || activeConfig.value?.id || '',
  set: (configId: string) => settings.selectLlmProviderConfig(configId)
});

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
});

const activeConfigName = computed(() => activeConfig.value?.name ?? '选择配置页');

function updateActiveConfigField<K extends keyof LlmProviderConfigRecord>(key: K, value: LlmProviderConfigRecord[K]): void {
  settings.updateActiveLlmProviderConfig({ [key]: value } as Partial<LlmProviderConfigRecord>);
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function selectValue(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}

function toggleConfigDropdown(): void {
  configDropdownOpen.value = !configDropdownOpen.value;
}

function selectConfigPage(configId: string): void {
  activeConfigId.value = configId;
  configDropdownOpen.value = false;
}

function onDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!configDropdownRoot.value?.contains(target)) configDropdownOpen.value = false;
}

function compactConfigName(name: string): string {
  return name.length > 64 ? `${name.slice(0, 61)}...` : name;
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
      <div ref="configDropdownRoot" class="global-settings-field channel-config-select">
        <span>配置页</span>
        <button
          type="button"
          class="channel-config-dropdown-button"
          :aria-expanded="configDropdownOpen"
          aria-haspopup="listbox"
          @click.stop="toggleConfigDropdown"
        >
          <span class="channel-config-dropdown-label">{{ activeConfigName }}</span>
          <IconCaretUp class="channel-config-dropdown-caret" :class="{ 'is-open': configDropdownOpen }" stroke="2" aria-hidden="true" />
        </button>
        <Transition name="lc-dropdown">
          <section v-if="configDropdownOpen" class="project-dropdown channel-config-dropdown lc-dropdown-panel" role="listbox" @click.stop>
            <div class="project-dropdown-title">切换配置页</div>
            <div v-if="!settings.llmProviderConfigs.configs.length" class="project-dropdown-empty">暂无渠道配置。</div>
            <button
              v-for="config in settings.llmProviderConfigs.configs"
              :key="config.id"
              type="button"
              class="project-option"
              :class="{ 'is-active': config.id === activeConfigId }"
              role="option"
              :aria-selected="config.id === activeConfigId"
              @click="selectConfigPage(config.id)"
            >
              <span class="project-option-name">{{ compactConfigName(config.name) }}</span>
            </button>
          </section>
        </Transition>
      </div>

      <div class="channel-config-actions" aria-label="渠道配置页操作">
        <button type="button" class="icon-action" aria-label="新建配置页" @click="settings.createLlmProviderConfig()">
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
        <select :value="activeConfig.provider" @change="updateActiveConfigField('provider', selectValue($event) as LlmProviderKind)">
          <option v-for="option in providerOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="global-settings-field">
        <span>模型名称</span>
        <input :value="activeConfig.model" type="text" placeholder="deepseek-v4-flash" @input="updateActiveConfigField('model', inputValue($event))" />
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
        <span>工具调用格式</span>
        <select :value="activeConfig.toolCallFormat" disabled>
          <option v-for="option in toolCallFormatOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
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
