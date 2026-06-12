<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconSearch } from '@tabler/icons-vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

export interface SettingsSelectableListItem {
  id: string;
  title: string;
  description?: string;
  meta?: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    items: SettingsSelectableListItem[];
    searchPlaceholder?: string;
    emptyText?: string;
    noMatchText?: string;
    maxHeight?: number;
  }>(),
  {
    searchPlaceholder: '筛选...',
    emptyText: '暂无可选项。',
    noMatchText: '没有匹配项。',
    maxHeight: 240
  }
);

const emit = defineEmits<{
  (event: 'select', item: SettingsSelectableListItem): void;
}>();

const filterText = ref('');
const scroller = ref<HTMLElement | null>(null);

const filteredItems = computed(() => {
  const keyword = filterText.value.trim().toLowerCase();
  if (!keyword) return props.items;
  return props.items.filter((item) => {
    return item.title.toLowerCase().includes(keyword)
      || (item.description?.toLowerCase().includes(keyword) ?? false)
      || (item.meta?.toLowerCase().includes(keyword) ?? false);
  });
});

watch(
  () => props.items,
  () => {
    filterText.value = '';
  }
);

function select(item: SettingsSelectableListItem): void {
  if (item.disabled) return;
  emit('select', item);
}
</script>

<template>
  <div class="settings-selectable-list">
    <label class="settings-selectable-filter" aria-label="筛选列表">
      <IconSearch stroke="2" aria-hidden="true" />
      <input v-model="filterText" type="text" :placeholder="searchPlaceholder" />
    </label>

    <div class="settings-selectable-shell">
      <div ref="scroller" class="settings-selectable-scroll" :style="{ maxHeight: `${maxHeight}px` }">
        <div class="settings-selectable-items">
          <div v-if="!items.length" class="settings-selectable-empty">{{ emptyText }}</div>
          <div v-else-if="!filteredItems.length" class="settings-selectable-empty">{{ noMatchText }}</div>
          <button
            v-for="item in filteredItems"
            :key="item.id"
            type="button"
            class="settings-selectable-item"
            :disabled="item.disabled"
            @click="select(item)"
          >
            <span class="settings-selectable-main">
              <span class="settings-selectable-title">{{ item.title }}</span>
              <span v-if="item.description" class="settings-selectable-description">{{ item.description }}</span>
            </span>
            <span v-if="item.meta" class="settings-selectable-meta">{{ item.meta }}</span>
          </button>
        </div>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>
  </div>
</template>

<style scoped>
.settings-selectable-list {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  overflow: hidden;
}

.settings-selectable-filter {
  min-height: 32px;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: 0 var(--space-2);
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-input-background);
}

.settings-selectable-filter svg {
  width: 15px;
  height: 15px;
}

.settings-selectable-filter input {
  width: 100%;
  min-height: 30px;
  border: 0;
  padding: 0;
  color: var(--vscode-input-foreground);
  background: transparent;
  outline: none;
  font: inherit;
}

.settings-selectable-shell {
  position: relative;
  min-height: 120px;
  overflow: hidden;
}

.settings-selectable-scroll {
  min-height: 120px;
  overflow-y: auto;
  scrollbar-width: none;
}

.settings-selectable-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.settings-selectable-items {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
}

.settings-selectable-empty {
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.settings-selectable-item {
  width: 100%;
  min-height: 52px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.settings-selectable-item:hover:not(:disabled),
.settings-selectable-item:focus-visible {
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.settings-selectable-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.settings-selectable-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-selectable-title,
.settings-selectable-description,
.settings-selectable-meta {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.settings-selectable-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.settings-selectable-description,
.settings-selectable-meta {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}
</style>
