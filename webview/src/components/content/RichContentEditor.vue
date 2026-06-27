<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    disabled?: boolean;
    rows?: number;
    /** 按 Enter（不含 Shift）是否触发 submit。Shift+Enter 始终换行。 */
    submitOnEnter?: boolean;
  }>(),
  { placeholder: '', disabled: false, rows: 2, submitOnEnter: true }
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'submit'): void;
  (event: 'paste-files', files: File[]): void;
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const scrollbarRefreshKey = ref(0);

const value = computed({
  get: () => props.modelValue,
  set: (next: string) => emit('update:modelValue', next)
});

watch(
  () => [props.modelValue, props.rows, props.disabled],
  () => queueScrollbarRefresh(),
  { flush: 'post' }
);

function onKeydown(event: KeyboardEvent): void {
  if (props.submitOnEnter && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('submit');
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = collectPastedFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    emit('paste-files', files);
  }
}

function collectPastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) return files;
  return Array.from(data.files ?? []);
}

function queueScrollbarRefresh(): void {
  void nextTick(() => {
    scrollbarRefreshKey.value += 1;
  });
}

function focus(): void {
  textarea.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <div class="rich-editor" :class="{ 'is-disabled': disabled }">
    <textarea
      ref="textarea"
      v-model="value"
      class="rich-editor-control"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      @keydown="onKeydown"
      @input="queueScrollbarRefresh"
      @paste="onPaste"
    ></textarea>
    <AdvancedScrollbar
      class="rich-editor-scrollbar"
      :scroller="textarea"
      :refresh-key="scrollbarRefreshKey"
      :show-markers="false"
      :show-edge-buttons="false"
      :show-marker-preview="false"
    />
  </div>
</template>

<style scoped>
.rich-editor {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  overflow: hidden;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-md);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.rich-editor:focus-within {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.rich-editor.is-disabled {
  opacity: 0.6;
}

.rich-editor-control {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  padding: var(--space-2) calc(var(--space-2) + 9px) var(--space-2) var(--space-2);
  overflow-y: auto;
  scrollbar-width: none;
}

.rich-editor-control::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.rich-editor-control::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.rich-editor :deep(.advanced-scrollbar.rich-editor-scrollbar) {
  top: 4px;
  right: 3px;
  bottom: 4px;
  width: 14px;
  z-index: 2;
  opacity: 0.72;
}

.rich-editor :deep(.advanced-scrollbar.rich-editor-scrollbar.is-hidden) {
  opacity: 0;
  pointer-events: none;
}

.rich-editor :deep(.rich-editor-scrollbar .scroll-track) {
  min-height: 24px;
  border-color: transparent;
  background: transparent;
}

.rich-editor :deep(.rich-editor-scrollbar .scroll-thumb) {
  left: 4px;
  right: 4px;
  min-height: 20px;
  border: 0;
  background: color-mix(in srgb, var(--vscode-input-foreground, var(--vscode-foreground)) 42%, transparent);
}

.rich-editor :deep(.rich-editor-scrollbar .scroll-thumb:hover),
.rich-editor :deep(.rich-editor-scrollbar.is-dragging .scroll-thumb) {
  background: color-mix(in srgb, var(--vscode-input-foreground, var(--vscode-foreground)) 62%, transparent);
}
</style>
