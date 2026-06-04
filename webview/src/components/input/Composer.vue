<script setup lang="ts">
import { ref } from 'vue';
import { IconSend2 } from '@tabler/icons-vue';
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

const draft = ref('');

function submit(): void {
  const text = draft.value.trim();
  if (!text || props.disabled) return;
  emit('submit', text);
  draft.value = '';
}
</script>

<template>
  <div class="composer">
    <div class="composer-zone composer-zone-top" aria-label="输入框上方功能区"></div>

    <div class="composer-input-row">
      <div class="composer-zone composer-zone-left" aria-label="输入框左侧功能区"></div>
      <RichContentEditor
        v-model="draft"
        class="composer-editor"
        :placeholder="placeholder"
        :disabled="disabled"
        :rows="2"
        @submit="submit"
      />
      <div class="composer-zone composer-zone-right" aria-label="输入框右侧功能区"></div>
    </div>

    <div class="composer-zone composer-zone-bottom" aria-label="输入框下方功能区">
      <button
        type="button"
        class="composer-send"
        :disabled="disabled || !draft.trim()"
        aria-label="发送消息"
        title="发送"
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

.composer-zone-bottom {
  justify-content: flex-end;
}

.composer-editor {
  flex: 1;
  min-width: 0;
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
