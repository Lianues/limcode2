<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconPencilExclamation, IconSend2 } from '@tabler/icons-vue';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import RichContentEditor from '@webview/components/content/RichContentEditor.vue';

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
  }>(),
  { disabled: false, placeholder: '' }
);

const emit = defineEmits<{
  (event: 'submit', text: string): void;
}>();

const ui = useConversationUiStore();
const highlighted = ref(false);
const editor = ref<{ focus: () => void } | null>(null);

const draft = computed({
  get: () => ui.composerDraft,
  set: (next: string) => ui.setComposerDraft(next)
});
const sendTitle = computed(() => (ui.isEditing ? '提交编辑' : '发送'));

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
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
});

function onWindowKeydown(event: KeyboardEvent): void {
  if (!ui.isEditing || event.key !== 'Escape') return;
  event.preventDefault();
  ui.cancelEditMode();
}

function submit(): void {
  const text = draft.value.trim();
  if (!text || props.disabled) return;
  emit('submit', text);
  if (!ui.isEditing) ui.clearChatDraft();
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
  <div class="composer" :class="{ 'is-editing': ui.isEditing, 'is-highlighted': highlighted }">
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
      <RichContentEditor
        ref="editor"
        v-model="draft"
        class="composer-editor"
        :placeholder="ui.isEditing ? '编辑消息内容...' : placeholder"
        :disabled="disabled"
        :rows="ui.isEditing ? 4 : 2"
        @submit="submit"
      />
      <div class="composer-zone composer-zone-right" aria-label="输入框右侧功能区"></div>
    </div>

    <div class="composer-zone composer-zone-bottom" aria-label="输入框下方功能区">
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
  gap: var(--space-2);
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

.composer-zone-top {
  justify-content: space-between;
}

.composer-zone-bottom {
  justify-content: flex-end;
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

.composer-editor {
  flex: 1;
  min-width: 0;
  transition: border-color var(--lc-composer-highlight-duration) ease, box-shadow var(--lc-composer-highlight-duration) ease;
}

.composer.is-highlighted .composer-editor {
  border-color: var(--vscode-editorWarning-foreground, #cca700);
  box-shadow: inset 0 0 0 1px var(--vscode-editorWarning-foreground, #cca700);
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
