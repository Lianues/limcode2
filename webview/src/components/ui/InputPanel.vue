<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { IconPencilQuestion } from '@tabler/icons-vue';

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
const panelId = `input-panel-${Math.random().toString(36).slice(2)}`;
const inputId = `${panelId}-input`;
const descriptionId = `${panelId}-description`;
const errorId = `${panelId}-error`;

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
    <div v-if="open" class="input-panel-backdrop" @click.self="cancel" @keydown="onKeydown">
      <section class="input-panel" role="dialog" aria-modal="true" :aria-labelledby="panelId" :aria-describedby="describedBy">
        <header class="input-panel-head">
          <h2 :id="panelId" class="input-panel-title">
            <span class="input-panel-title-icon" aria-hidden="true">
              <IconPencilQuestion stroke="2" />
            </span>
            <span>{{ title }}</span>
          </h2>
          <p v-if="description" :id="descriptionId" class="input-panel-desc">{{ description }}</p>
        </header>

        <div class="input-panel-field">
          <label v-if="label" class="input-panel-label" :for="inputId">{{ label }}</label>
          <input
            :id="inputId"
            ref="inputElement"
            class="input-panel-input"
            :class="{ invalid: !!errorText }"
            :value="draft"
            :placeholder="placeholder"
            type="text"
            autocomplete="off"
            spellcheck="false"
            @input="updateDraft"
          />
          <p v-if="errorText" :id="errorId" class="input-panel-error">{{ errorText }}</p>
        </div>

        <footer class="input-panel-actions">
          <button type="button" class="input-panel-button secondary" @click="cancel">{{ cancelLabel }}</button>
          <button type="button" class="input-panel-button primary" :disabled="!canConfirm" @click="confirm">{{ confirmLabel }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.input-panel-backdrop {
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

.input-panel {
  width: min(540px, 100%);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-md);
  padding: var(--space-4);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background, var(--vscode-sideBar-background));
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  animation: lc-dialog-panel-in var(--lc-dialog-panel-in-duration) var(--lc-dialog-panel-ease);
}

.input-panel-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.input-panel-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: calc(var(--font-size-lg) + 3px);
  line-height: 1.35;
  font-weight: 650;
}

.input-panel-title-icon {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
}

.input-panel-title-icon :deep(svg) {
  width: 28px;
  height: 28px;
}

.input-panel-desc {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-lg);
  line-height: 1.5;
}

.input-panel-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.input-panel-label {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.input-panel-input {
  width: 100%;
  min-height: 34px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  outline: none;
  font: inherit;
  font-size: var(--font-size-lg);
}

.input-panel-input:focus {
  border-color: var(--vscode-focusBorder);
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}

.input-panel-input.invalid {
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
}

.input-panel-error {
  margin: 0;
  color: var(--vscode-errorForeground);
  font-size: var(--font-size-sm);
  line-height: 1.35;
}

.input-panel-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
  flex-wrap: wrap;
}

.input-panel-button {
  min-width: 64px;
  min-height: 34px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-sm);
  padding: 0 var(--space-3);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
  font-size: calc(var(--font-size-lg) + 2px);
  cursor: pointer;
}

.input-panel-button.secondary {
  color: var(--vscode-descriptionForeground);
}

.input-panel-button.secondary:hover,
.input-panel-button.secondary:focus-visible {
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
  outline: none;
}

.input-panel-button.primary {
  color: var(--vscode-foreground);
  background: transparent;
}

.input-panel-button.primary:hover:not(:disabled),
.input-panel-button.primary:focus-visible:not(:disabled) {
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
  outline: none;
}

.input-panel-button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
