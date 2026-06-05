<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconPencilExclamation, IconSend2 } from '@tabler/icons-vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import RichContentEditor from '@webview/components/content/RichContentEditor.vue';

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
    expandBoundary?: HTMLElement | null;
  }>(),
  { disabled: false, placeholder: '', expandBoundary: null }
);

const emit = defineEmits<{
  (event: 'submit', text: string): void;
}>();

const clientState = useClientStateStore();
const ui = useConversationUiStore();
const highlighted = ref(false);
const editorExpanded = ref(false);
const editor = ref<{ focus: () => void } | null>(null);
const editorShell = ref<HTMLElement | null>(null);
const expandedEditorHeight = ref(0);
const collapsedEditorHeight = ref(0);

const draft = computed({
  get: () => ui.composerDraft,
  set: (next: string) => ui.setComposerDraft(next)
});
const expandTitle = computed(() => (editorExpanded.value ? '恢复输入框高度' : '扩大输入框'));
const sendTitle = computed(() => (ui.isEditing ? '提交编辑' : '发送'));
const modelSummary = computed(() => clientState.currentModelSummary);
const editorShellStyle = computed(() => {
  if (!editorExpanded.value || !expandedEditorHeight.value) return undefined;
  return {
    '--composer-expanded-editor-height': `${expandedEditorHeight.value}px`
  };
});

let highlightTimer: number | undefined;

watch(
  () => ui.composerHighlightKey,
  () => {
    if (!ui.isEditing) return;
    pulseHighlight();
    void nextTick(() => editor.value?.focus());
  }
);

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown);
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  window.removeEventListener('resize', onWindowResize);
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
});

function onWindowKeydown(event: KeyboardEvent): void {
  if (!ui.isEditing || event.key !== 'Escape') return;
  event.preventDefault();
  ui.cancelEditMode();
}

function onWindowResize(): void {
  if (!editorExpanded.value) return;
  updateExpandedEditorHeight();
}

function submit(): void {
  const text = draft.value.trim();
  if (!text || props.disabled) return;
  emit('submit', text);
  if (!ui.isEditing) ui.clearChatDraft();
}

function toggleEditorExpanded(): void {
  if (!editorExpanded.value) {
    collapsedEditorHeight.value = editorShell.value?.getBoundingClientRect().height ?? 0;
    updateExpandedEditorHeight();
  }

  editorExpanded.value = !editorExpanded.value;
  void nextTick(() => {
    if (editorExpanded.value) updateExpandedEditorHeight();
    editor.value?.focus();
  });
}

function updateExpandedEditorHeight(): void {
  const shell = editorShell.value;
  if (!shell) return;

  const shellRect = shell.getBoundingClientRect();
  const boundaryRect = props.expandBoundary?.getBoundingClientRect();
  const boundaryTop = boundaryRect?.top ?? 0;
  const availableHeight = shellRect.bottom - boundaryTop;
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return;

  const minHeight = collapsedEditorHeight.value || shellRect.height;
  expandedEditorHeight.value = Math.floor(Math.min(availableHeight, Math.max(minHeight, availableHeight * 0.9)));
}

function pulseHighlight(): void {
  highlighted.value = true;
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    highlighted.value = false;
    highlightTimer = undefined;
  }, 650);
}
</script>

<template>
  <div class="composer" :class="{ 'is-editing': ui.isEditing, 'is-highlighted': highlighted, 'is-editor-expanded': editorExpanded }">
    <div class="composer-zone composer-zone-top" aria-label="输入框上方功能区">
      <div v-if="ui.isEditing" class="composer-edit-indicator">
        <span class="composer-edit-indicator-icon" aria-hidden="true">
          <IconPencilExclamation stroke="2" />
        </span>
        <span class="composer-edit-text">正在编辑消息，发送前需要确认。</span>
        <button type="button" class="composer-edit-cancel" @click="ui.cancelEditMode">取消编辑</button>
      </div>
    </div>

    <div class="composer-input-row">
      <div class="composer-zone composer-zone-left" aria-label="输入框左侧功能区"></div>
      <div ref="editorShell" class="composer-editor-shell" :style="editorShellStyle">
        <RichContentEditor
          ref="editor"
          v-model="draft"
          class="composer-editor"
          :placeholder="ui.isEditing ? '编辑消息内容...' : placeholder"
          :disabled="disabled"
          :rows="5"
          @submit="submit"
        />
      </div>
      <div class="composer-zone composer-zone-right" aria-label="输入框右侧功能区">
        <button
          type="button"
          class="composer-side-action"
          :aria-label="expandTitle"
          :aria-pressed="editorExpanded"
          :title="expandTitle"
          @click="toggleEditorExpanded"
        >
          <svg
            v-if="!editorExpanded"
            class="composer-side-action-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M9 18l3 3l3 -3" />
            <path d="M12 15v6" />
            <path d="M15 6l-3 -3l-3 3" />
            <path d="M12 3v6" />
          </svg>
          <svg
            v-else
            class="composer-side-action-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M9 6l3 3l3 -3" />
            <path d="M12 3v6" />
            <path d="M15 18l-3 -3l-3 3" />
            <path d="M12 15v6" />
          </svg>
        </button>
      </div>
    </div>

    <div class="composer-zone composer-zone-bottom" aria-label="输入框下方功能区">
      <span v-if="modelSummary.modeName || modelSummary.model" class="composer-meta">
        <template v-if="modelSummary.modeName">模式：<code>{{ modelSummary.modeName }}</code></template>
        <template v-if="modelSummary.model"> · 模型：<code>{{ modelSummary.model }}</code></template>
      </span>
      <button
        type="button"
        class="composer-send"
        :disabled="disabled || !draft.trim()"
        :aria-label="sendTitle"
        :title="sendTitle"
        @click="submit"
      >
        <IconSend2 class="composer-send-icon" stroke="2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.composer-input-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
  min-width: 0;
}

.composer-zone {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.composer-zone:empty {
  display: none;
}

.composer-zone-left,
.composer-zone-right {
  flex: 0 0 auto;
}

.composer-zone-right {
  align-self: stretch;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: var(--space-1);
}

.composer-zone-top {
  justify-content: space-between;
}

.composer-zone-bottom {
  justify-content: flex-end;
  align-items: center;
}

.composer-edit-indicator {
  width: 100%;
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.composer-edit-indicator-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.composer-edit-indicator-icon :deep(svg) {
  width: 16px;
  height: 16px;
}

.composer-edit-text {
  flex: 1;
  min-width: 0;
}

.composer-edit-cancel {
  min-height: 24px;
  padding: 0 var(--space-2);
  border-color: transparent;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.composer-edit-cancel:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.composer-editor-shell {
  flex: 1;
  min-width: 0;
  display: flex;
}

.composer.is-editor-expanded .composer-editor-shell {
  height: var(--composer-expanded-editor-height);
}

.composer-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  transition: border-color var(--lc-composer-highlight-duration) ease, box-shadow var(--lc-composer-highlight-duration) ease;
}

.composer.is-editor-expanded .composer-editor {
  height: 100%;
}

.composer.is-highlighted .composer-editor {
  border-color: var(--vscode-editorWarning-foreground, #cca700);
  box-shadow: inset 0 0 0 1px var(--vscode-editorWarning-foreground, #cca700);
}

.composer-side-action {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}

.composer-side-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.composer-side-action:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  border-color: transparent;
  opacity: 0.55;
  cursor: not-allowed;
}

.composer-side-action-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}

.composer-meta {
  flex: 1 1 auto;
  min-width: 0;
  margin-right: auto;
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.composer-meta code {
  font-size: inherit;
}

.composer-send {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 30px;
  padding: 0;
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.composer-send:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.composer-send:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  border-color: transparent;
  opacity: 0.55;
  cursor: not-allowed;
}

.composer-send-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}
</style>
