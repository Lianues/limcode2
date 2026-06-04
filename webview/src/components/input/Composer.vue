<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconPencilExclamation, IconSend2 } from '@tabler/icons-vue';
import RichContentEditor from '@webview/components/content/RichContentEditor.vue';

type ComposerMode = 'chat' | 'edit';
type ComposerZone = 'top' | 'left' | 'right' | 'bottom';
type ComposerZoneSnapshot = Record<string, unknown>;

interface ComposerSnapshot {
  draft: string;
  zones: Record<ComposerZone, ComposerZoneSnapshot>;
}

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
    mode?: ComposerMode;
    editText?: string;
    editKey?: string;
  }>(),
  { disabled: false, placeholder: '', mode: 'chat', editText: '', editKey: '' }
);

const emit = defineEmits<{
  (event: 'submit', text: string): void;
  (event: 'cancel-edit'): void;
}>();

/**
 * 输入框状态快照。
 * draft 是当前输入文字；zones 预留给顶部/左右/底部功能区（例如附件、引用、工具开关等），
 * 这样后续新增输入框功能时，可以按 chat/edit 等上下文隔离状态，避免互相污染。
 */
const snapshots = ref<Record<ComposerMode, ComposerSnapshot>>({
  chat: createSnapshot(),
  edit: createSnapshot()
});
const activeMode = ref<ComposerMode>(props.mode);
const highlighted = ref(false);
const editor = ref<{ focus: () => void } | null>(null);

const isEditing = computed(() => activeMode.value === 'edit');
const activeSnapshot = computed(() => snapshots.value[activeMode.value]);
const draft = computed({
  get: () => activeSnapshot.value.draft,
  set: (next: string) => {
    activeSnapshot.value.draft = next;
  }
});
const sendTitle = computed(() => (isEditing.value ? '提交编辑' : '发送'));

let highlightTimer: number | undefined;

watch(
  () => [props.mode, props.editKey] as const,
  ([mode, editKey], previous) => {
    const previousMode = previous?.[0];
    const previousEditKey = previous?.[1];

    if (mode === 'edit') {
      activeMode.value = 'edit';
      if (previousMode !== 'edit' || editKey !== previousEditKey) {
        snapshots.value.edit = createSnapshot(props.editText);
        pulseHighlight();
        void nextTick(() => editor.value?.focus());
      }
      return;
    }

    activeMode.value = 'chat';
    snapshots.value.edit = createSnapshot();
  },
  { immediate: true }
);

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
});

function onWindowKeydown(event: KeyboardEvent): void {
  if (!isEditing.value || event.key !== 'Escape') return;
  event.preventDefault();
  cancelEdit();
}

function submit(): void {
  const text = draft.value.trim();
  if (!text || props.disabled) return;
  emit('submit', text);
  if (!isEditing.value) snapshots.value.chat.draft = '';
}

function cancelEdit(): void {
  emit('cancel-edit');
}

function pulseHighlight(): void {
  highlighted.value = true;
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    highlighted.value = false;
    highlightTimer = undefined;
  }, 650);
}

function createSnapshot(draft = ''): ComposerSnapshot {
  return {
    draft,
    zones: {
      top: {},
      left: {},
      right: {},
      bottom: {}
    }
  };
}
</script>

<template>
  <div class="composer" :class="{ 'is-editing': isEditing, 'is-highlighted': highlighted }">
    <div class="composer-zone composer-zone-top" aria-label="输入框上方功能区">
      <div v-if="isEditing" class="composer-edit-indicator">
        <span class="composer-edit-indicator-icon" aria-hidden="true">
          <IconPencilExclamation stroke="2" />
        </span>
        <span class="composer-edit-text">正在编辑消息，发送前需要确认。</span>
        <button type="button" class="composer-edit-cancel" @click="cancelEdit">取消编辑</button>
      </div>
    </div>

    <div class="composer-input-row">
      <div class="composer-zone composer-zone-left" aria-label="输入框左侧功能区"></div>
      <RichContentEditor
        ref="editor"
        v-model="draft"
        class="composer-editor"
        :placeholder="isEditing ? '编辑消息内容...' : placeholder"
        :disabled="disabled"
        :rows="isEditing ? 4 : 2"
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
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
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
