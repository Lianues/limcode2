<script setup lang="ts">
import { computed } from 'vue';
import { IconQuestionMark } from '@tabler/icons-vue';

export interface ConfirmPanelAction {
  key: string;
  label: string;
  variant?: 'default' | 'secondary' | 'danger';
  disabled?: boolean;
  title?: string;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    descriptionHtml?: string;
    actions?: ConfirmPanelAction[];
    cancelLabel?: string;
    confirmLabel?: string;
    danger?: boolean;
  }>(),
  {
    description: '',
    descriptionHtml: '',
    actions: undefined,
    cancelLabel: '取消',
    confirmLabel: '确认',
    danger: false
  }
);

const emit = defineEmits<{
  (event: 'action', action: ConfirmPanelAction): void;
  (event: 'cancel'): void;
  (event: 'confirm'): void;
}>();

const panelActions = computed<ConfirmPanelAction[]>(() => {
  if (props.actions?.length) return props.actions;
  return [
    { key: 'cancel', label: props.cancelLabel, variant: 'secondary' },
    { key: 'confirm', label: props.confirmLabel, variant: props.danger ? 'danger' : 'default' }
  ];
});

function actionVariant(action: ConfirmPanelAction): ConfirmPanelAction['variant'] {
  return action.variant ?? 'default';
}

function onAction(action: ConfirmPanelAction): void {
  emit('action', action);
  if (action.key === 'cancel') emit('cancel');
  if (action.key === 'confirm') emit('confirm');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="confirm-panel-backdrop" @click.self="emit('cancel')">
      <section class="confirm-panel" role="dialog" aria-modal="true" :aria-label="title">
        <header class="confirm-panel-head">
          <h2 class="confirm-panel-title">
            <span class="confirm-panel-title-icon" aria-hidden="true">
              <IconQuestionMark stroke="2.8" />
            </span>
            <span>{{ title }}</span>
          </h2>
          <p v-if="descriptionHtml" class="confirm-panel-desc" v-html="descriptionHtml"></p>
          <p v-else-if="description" class="confirm-panel-desc">{{ description }}</p>
        </header>
        <div v-if="$slots.default" class="confirm-panel-content">
          <slot />
        </div>
        <footer class="confirm-panel-actions">
          <button
            v-for="action in panelActions"
            :key="action.key"
            type="button"
            class="confirm-panel-button"
            :class="actionVariant(action)"
            :disabled="action.disabled"
            :title="action.title"
            @click="onAction(action)"
          >
            {{ action.label }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-panel-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  background: rgba(0, 0, 0, 0.48);
  animation: lc-dialog-backdrop-in var(--lc-dialog-backdrop-in-duration) ease-out;
}

.confirm-panel {
  width: min(540px, 100%);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-md);
  padding: var(--space-4);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  animation: lc-dialog-panel-in var(--lc-dialog-panel-in-duration) var(--lc-dialog-panel-ease);
}

.confirm-panel-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.confirm-panel-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: calc(var(--font-size-lg) + 3px);
  line-height: 1.35;
  font-weight: 650;
}

.confirm-panel-title-icon {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  stroke-width: 2.6;
}

.confirm-panel-title-icon :deep(svg) {
  width: 28px;
  height: 28px;
}

.confirm-panel-desc {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-lg);
  line-height: 1.5;
}

.confirm-panel-desc :deep(strong) {
  color: var(--vscode-foreground);
  font-weight: 700;
}

.confirm-panel-content {
  min-width: 0;
  margin-top: var(--space-3);
}

.confirm-panel-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
  flex-wrap: wrap;
}

.confirm-panel-button {
  min-width: 64px;
  min-height: 34px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  padding: 0 var(--space-3);
  color: var(--vscode-foreground);
  background: transparent;
  font-size: calc(var(--font-size-lg) + 2px);
}

.confirm-panel-button:hover:not(:disabled),
.confirm-panel-button:focus-visible {
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
}

.confirm-panel-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.confirm-panel-button.danger {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
}

.confirm-panel-button.secondary {
  color: var(--vscode-descriptionForeground);
}
</style>
