<script setup lang="ts">
import { computed } from 'vue';
import { IconPlus } from '@tabler/icons-vue';
import SettingsSelectableList, { type SettingsSelectableListItem } from '../SettingsSelectableList.vue';
import type { LlmParameterDefinition } from './llmParameterDefinitions';

export interface LlmParameterAddOption extends LlmParameterDefinition {
  disabled?: boolean;
  disabledReason?: string;
}

const props = defineProps<{
  open: boolean;
  definitions: LlmParameterAddOption[];
  providerLabel: string;
}>();

const emit = defineEmits<{
  (event: 'add-known', key: string): void;
  (event: 'add-custom'): void;
  (event: 'close'): void;
}>();

const items = computed<SettingsSelectableListItem[]>(() => [
  ...props.definitions.map((definition) => ({
    id: `known:${definition.key}`,
    title: definition.label,
    description: definition.description,
    meta: definition.displayPath,
    disabledReason: definition.disabledReason,
    disabled: definition.disabled
  })),
  {
    id: 'custom:requestBody',
    title: '自定义参数',
    description: '写入 provider 原生 requestBody 补丁，可深覆盖最终请求体。',
    meta: 'requestBody.*'
  }
]);

function select(item: SettingsSelectableListItem): void {
  if (item.id === 'custom:requestBody') {
    emit('add-custom');
    emit('close');
    return;
  }
  if (item.id.startsWith('known:')) {
    if (item.disabled) return;
    emit('add-known', item.id.slice('known:'.length));
    emit('close');
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="parameter-add-backdrop" @click.self="emit('close')">
      <section class="parameter-add-panel" role="dialog" aria-modal="true" aria-label="添加渠道参数">
        <header class="parameter-add-header">
          <h3>
            <IconPlus stroke="2" aria-hidden="true" />
            <span>添加参数</span>
          </h3>
          <button type="button" class="parameter-add-close" aria-label="关闭" @click="emit('close')">×</button>
        </header>
        <p class="parameter-add-desc">当前渠道：{{ providerLabel }}。列表会按渠道类型过滤可添加参数。</p>
        <SettingsSelectableList
          :items="items"
          search-placeholder="筛选参数..."
          empty-text="当前渠道暂无可添加参数。"
          no-match-text="没有匹配的参数。"
          :max-height="320"
          @select="select"
        />
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.parameter-add-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  background: rgba(0, 0, 0, 0.48);
  animation: lc-dialog-backdrop-in var(--lc-dialog-backdrop-in-duration) ease-out;
}

.parameter-add-panel {
  width: min(620px, 100%);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-md);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background, var(--vscode-sideBar-background));
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  animation: lc-dialog-panel-in var(--lc-dialog-panel-in-duration) var(--lc-dialog-panel-ease);
}

.parameter-add-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.parameter-add-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-lg);
}

.parameter-add-header svg {
  width: 20px;
  height: 20px;
}

.parameter-add-close {
  width: 28px;
  height: 28px;
  min-width: 0;
  min-height: 0;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 0;
  color: var(--vscode-foreground);
  background: transparent;
  font-size: 18px;
  line-height: 1;
}

.parameter-add-close:hover:not(:disabled),
.parameter-add-close:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.parameter-add-desc {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
</style>
