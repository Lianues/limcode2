<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    label?: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    required?: boolean;
  }>(),
  {
    description: '',
    label: '',
    initialValue: '',
    placeholder: '',
    confirmLabel: '保存',
    cancelLabel: '取消',
    required: true
  }
);

const emit = defineEmits<{
  (event: 'confirm', value: string): void;
  (event: 'cancel'): void;
}>();

const draft = ref('');
const inputElement = ref<HTMLInputElement>();
const dialogId = `sidebar-input-dialog-${Math.random().toString(36).slice(2)}`;
const inputId = `${dialogId}-input`;
const descriptionId = `${dialogId}-description`;
const errorId = `${dialogId}-error`;

const trimmedDraft = computed(() => draft.value.trim());
const errorText = computed(() => props.required && !trimmedDraft.value ? '标题不能为空' : '');
const canConfirm = computed(() => !errorText.value);
const describedBy = computed(() => {
  const ids: string[] = [];
  if (props.description) ids.push(descriptionId);
  if (errorText.value) ids.push(errorId);
  return ids.join(' ') || undefined;
});

watch(
  () => [props.open, props.initialValue] as const,
  ([open, initialValue]) => {
    if (!open) return;
    draft.value = initialValue ?? '';
    void nextTick(() => {
      inputElement.value?.focus();
      inputElement.value?.select();
    });
  },
  { immediate: true }
);

function cancel(): void {
  emit('cancel');
}

function confirm(): void {
  if (!canConfirm.value) {
    inputElement.value?.focus();
    return;
  }
  emit('confirm', draft.value);
}

function updateDraft(event: Event): void {
  draft.value = (event.target as HTMLInputElement).value;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
    return;
  }

  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    confirm();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sidebar-dialog-backdrop" @click.self="cancel" @keydown="onKeydown">
      <section class="sidebar-dialog" role="dialog" aria-modal="true" :aria-labelledby="dialogId" :aria-describedby="describedBy">
        <header class="sidebar-dialog-head">
          <h2 :id="dialogId" class="sidebar-dialog-title">{{ title }}</h2>
          <p v-if="description" :id="descriptionId" class="sidebar-dialog-desc">{{ description }}</p>
        </header>

        <div class="sidebar-dialog-field">
          <label v-if="label" class="sidebar-dialog-label" :for="inputId">{{ label }}</label>
          <input
            :id="inputId"
            ref="inputElement"
            class="sidebar-dialog-input"
            :class="{ invalid: !!errorText }"
            :value="draft"
            :placeholder="placeholder"
            type="text"
            autocomplete="off"
            spellcheck="false"
            @input="updateDraft"
          />
          <p v-if="errorText" :id="errorId" class="sidebar-dialog-error">{{ errorText }}</p>
        </div>

        <footer class="sidebar-dialog-actions">
          <button type="button" class="sidebar-dialog-button secondary" @click="cancel">{{ cancelLabel }}</button>
          <button type="button" class="sidebar-dialog-button primary" :disabled="!canConfirm" @click="confirm">{{ confirmLabel }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.sidebar-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  background: rgba(0, 0, 0, 0.38);
}

.sidebar-dialog {
  width: min(340px, calc(100vw - 20px));
  border: 1px solid var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border));
  border-radius: var(--radius-md);
  padding: 12px;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
}

.sidebar-dialog-head {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.sidebar-dialog-title {
  margin: 0;
  font-size: 13px;
  line-height: 1.35;
  font-weight: 650;
}

.sidebar-dialog-desc {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 1.45;
}

.sidebar-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 12px;
}

.sidebar-dialog-label {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.sidebar-dialog-input {
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: 0 8px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  outline: none;
  font: inherit;
}

.sidebar-dialog-input:focus {
  border-color: var(--vscode-focusBorder);
}

.sidebar-dialog-input.invalid {
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
}

.sidebar-dialog-error {
  margin: 0;
  color: var(--vscode-errorForeground);
  font-size: 11px;
  line-height: 1.35;
}

.sidebar-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.sidebar-dialog-button {
  min-width: 58px;
  min-height: 28px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: var(--radius-sm);
  padding: 0 10px;
  font: inherit;
  cursor: pointer;
}

.sidebar-dialog-button.secondary {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border));
}

.sidebar-dialog-button.secondary:hover,
.sidebar-dialog-button.secondary:focus-visible {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
  outline: none;
}

.sidebar-dialog-button.primary {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.sidebar-dialog-button.primary:hover:not(:disabled),
.sidebar-dialog-button.primary:focus-visible:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
  border-color: var(--vscode-button-hoverBackground);
  outline: none;
}

.sidebar-dialog-button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
