<script setup lang="ts">
import { computed } from 'vue';

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
}>();

const value = computed({
  get: () => props.modelValue,
  set: (next: string) => emit('update:modelValue', next)
});

function onKeydown(event: KeyboardEvent): void {
  if (props.submitOnEnter && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('submit');
  }
}
</script>

<template>
  <textarea
    v-model="value"
    class="rich-editor"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    @keydown="onKeydown"
  ></textarea>
</template>

<style scoped>
.rich-editor {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-md);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: var(--space-2);
}

.rich-editor:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.rich-editor:disabled {
  opacity: 0.6;
}
</style>
