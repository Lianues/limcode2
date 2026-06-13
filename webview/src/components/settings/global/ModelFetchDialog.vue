<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconFilter2Question, IconSearch } from '@tabler/icons-vue';
import type { LlmProviderModelRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';

const props = defineProps<{
  open: boolean;
  loading?: boolean;
  models: LlmProviderModelRecord[];
}>();

const emit = defineEmits<{
  (event: 'add', models: LlmProviderModelRecord[]): void;
  (event: 'close'): void;
}>();

const filterText = ref('');
const selectedIds = ref<string[]>([]);
const scroller = ref<HTMLElement | null>(null);

const filteredModels = computed(() => {
  const keyword = filterText.value.trim().toLowerCase();
  if (!keyword) return props.models;
  return props.models.filter((model) => {
    return model.id.toLowerCase().includes(keyword)
      || model.name.toLowerCase().includes(keyword)
      || (model.createdAt?.toLowerCase().includes(keyword) ?? false);
  });
});
const selectedSet = computed(() => new Set(selectedIds.value));
const selectedModels = computed(() => props.models.filter((model) => selectedSet.value.has(model.id)));
const allFilteredSelected = computed(() => filteredModels.value.length > 0 && filteredModels.value.every((model) => selectedSet.value.has(model.id)));

watch(
  () => [props.open, props.models] as const,
  ([open]) => {
    if (!open) return;
    filterText.value = '';
    selectedIds.value = [];
  },
  { immediate: true }
);

function toggleModel(modelId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(modelId)) next.delete(modelId);
  else next.add(modelId);
  selectedIds.value = [...next];
}

function toggleAllFiltered(): void {
  const next = new Set(selectedIds.value);
  if (allFilteredSelected.value) {
    for (const model of filteredModels.value) next.delete(model.id);
  } else {
    for (const model of filteredModels.value) next.add(model.id);
  }
  selectedIds.value = [...next];
}

function close(): void {
  emit('close');
}

function addSelected(): void {
  if (selectedModels.value.length === 0) return;
  emit('add', selectedModels.value);
}

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
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="model-fetch-backdrop" @click.self="close">
      <section class="model-fetch-dialog" role="dialog" aria-modal="true" aria-label="选择要添加的模型">
        <header class="model-fetch-header">
          <h4 class="model-fetch-title">
            <IconFilter2Question stroke="2" aria-hidden="true" />
            <span>选择要添加的模型</span>
          </h4>
          <div class="model-fetch-header-actions">
            <button type="button" class="model-fetch-header-button" :disabled="loading || !filteredModels.length" @click="toggleAllFiltered">
              <span>{{ allFilteredSelected ? '取消全选' : '全选' }}</span>
            </button>
            <button type="button" class="model-fetch-close" aria-label="关闭" @click="close">×</button>
          </div>
        </header>

        <div class="model-fetch-body" :class="{ 'is-loading': loading }">
          <label class="model-filter-box" aria-label="筛选模型">
            <IconSearch stroke="2" aria-hidden="true" />
            <input v-model="filterText" type="text" placeholder="筛选模型..." :disabled="loading" />
          </label>

          <div class="model-fetch-list-shell">
            <div ref="scroller" class="model-fetch-list-scroll">
              <div class="model-fetch-list">
                <div v-if="!models.length" class="model-fetch-empty">没有获取到模型。</div>
                <div v-else-if="!filteredModels.length" class="model-fetch-empty">没有匹配的模型。</div>
                <button
                  v-for="model in filteredModels"
                  :key="model.id"
                  type="button"
                  class="model-fetch-item"
                  :class="{ selected: selectedSet.has(model.id) }"
                  @click="toggleModel(model.id)"
                >
                  <LcCheckbox class="model-fetch-checkbox" :model-value="selectedSet.has(model.id)" size="sm" presentation />
                  <span class="model-fetch-info">
                    <span class="model-fetch-name">{{ model.name }}</span>
                    <span class="model-fetch-id">ID: {{ model.id }}</span>
                    <span v-if="model.createdAt" class="model-fetch-time">时间: {{ formatModelTime(model.createdAt) }}</span>
                  </span>
                </button>
              </div>
            </div>
            <AdvancedScrollbar :scroller="scroller" variant="minimal" />
          </div>

          <Transition name="model-fetch-loading-fade">
            <div v-if="loading" class="model-fetch-loading" role="status" aria-live="polite">
              <div class="model-fetch-loading-card">
                <div class="model-fetch-loading-spinner" aria-hidden="true"></div>
                <div class="model-fetch-loading-text">
                  <strong>正在获取模型列表...</strong>
                  <span>请稍候，模型列表加载完成后会自动显示。</span>
                </div>
              </div>
            </div>
          </Transition>
        </div>

        <footer class="model-fetch-footer">
          <span class="model-fetch-selection-count">已选择 {{ selectedModels.length }} 个模型</span>
          <div class="model-fetch-actions">
            <button type="button" class="model-fetch-button secondary" @click="close">取消</button>
            <button type="button" class="model-fetch-button primary" :disabled="loading || selectedModels.length === 0" @click="addSelected">
              添加 ({{ selectedModels.length }})
            </button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.model-fetch-backdrop {
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

.model-fetch-dialog {
  width: min(620px, 100%);
  max-height: min(680px, calc(100vh - 20px));
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background, var(--vscode-sideBar-background));
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  overflow: hidden;
  animation: lc-dialog-panel-in var(--lc-dialog-panel-in-duration) var(--lc-dialog-panel-ease);
}

.model-fetch-header,
.model-fetch-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
}

.model-fetch-header {
  border-bottom: 1px solid var(--vscode-panel-border);
}

.model-fetch-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 650;
}

.model-fetch-title svg {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
}

.model-fetch-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.model-fetch-header-button,
.model-fetch-close,
.model-fetch-button {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
}

.model-fetch-header-button {
  min-height: 28px;
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
}

.model-fetch-close {
  width: 28px;
  height: 28px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  font-size: 18px;
  line-height: 1;
}

.model-fetch-header-button:hover:not(:disabled),
.model-fetch-header-button:focus-visible,
.model-fetch-close:hover:not(:disabled),
.model-fetch-close:focus-visible,
.model-fetch-button:hover:not(:disabled),
.model-fetch-button:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.model-fetch-body {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  position: relative;
}

.model-fetch-body.is-loading .model-fetch-list-shell,
.model-fetch-body.is-loading .model-filter-box {
  opacity: 0.32;
  pointer-events: none;
  transition: opacity 0.16s ease;
}

.model-fetch-loading {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, var(--vscode-editor-background) 64%, transparent);
  pointer-events: auto;
}

.model-fetch-loading-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.24);
}

.model-fetch-loading-spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-top-color: var(--vscode-foreground);
  animation: model-fetch-loading-spin 0.8s linear infinite;
}

.model-fetch-loading-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  text-align: center;
}

.model-fetch-loading-text strong {
  font-size: var(--font-size-md);
  font-weight: 600;
}

.model-fetch-loading-text span {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.model-fetch-loading-fade-enter-active,
.model-fetch-loading-fade-leave-active {
  transition: opacity 0.18s ease;
}

.model-fetch-loading-fade-enter-from,
.model-fetch-loading-fade-leave-to {
  opacity: 0;
}

@keyframes model-fetch-loading-spin {
  to { transform: rotate(360deg); }
}

.model-filter-box {
  min-height: 34px;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: 0 var(--space-3);
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-input-background);
}

.model-filter-box svg {
  width: 15px;
  height: 15px;
}

.model-filter-box input {
  width: 100%;
  min-height: 32px;
  border: 0;
  padding: 0;
  color: var(--vscode-input-foreground);
  background: transparent;
  outline: none;
  font: inherit;
}

.model-fetch-list-shell {
  position: relative;
  min-height: 160px;
  max-height: 300px;
  overflow: hidden;
}

.model-fetch-list-scroll {
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: none;
}

.model-fetch-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.model-fetch-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
}

.model-fetch-empty {
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.model-fetch-item {
  width: 100%;
  min-height: 50px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.model-fetch-item:hover:not(:disabled),
.model-fetch-item:focus-visible,
.model-fetch-item.selected {
  border-color: var(--vscode-panel-border, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.model-fetch-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-fetch-name,
.model-fetch-id,
.model-fetch-time {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.model-fetch-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.model-fetch-id,
.model-fetch-time {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.model-fetch-footer {
  border-top: 1px solid var(--vscode-panel-border);
  flex-wrap: wrap;
}

.model-fetch-selection-count {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.model-fetch-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.model-fetch-button {
  min-width: 72px;
  min-height: 32px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-sm);
}

.model-fetch-button.secondary {
  color: var(--vscode-descriptionForeground);
}

.model-fetch-button:disabled,
.model-fetch-header-button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
