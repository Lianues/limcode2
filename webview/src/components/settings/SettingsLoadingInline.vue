<script setup lang="ts">
withDefaults(defineProps<{
  show?: boolean;
  text: string;
}>(), {
  show: false
});
</script>

<template>
  <Transition name="settings-loading-fade">
    <span v-if="show" class="settings-loading-inline" role="status" aria-live="polite">
      <span class="settings-loading-spinner" aria-hidden="true"></span>
      <span>{{ text }}</span>
    </span>
  </Transition>
</template>

<style scoped>
.settings-loading-inline {
  min-height: 20px;
  margin-left: var(--space-2);
  border-radius: var(--radius-sm);
  padding: 1px var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  vertical-align: middle;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
  font-size: var(--font-size-xs);
  font-weight: 400;
  line-height: 1.4;
}

.settings-loading-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-top-color: currentColor;
  animation: settings-loading-spin 0.8s linear infinite;
}

.settings-loading-fade-enter-active,
.settings-loading-fade-leave-active {
  transition: opacity 0.16s ease;
}

.settings-loading-fade-enter-from,
.settings-loading-fade-leave-to {
  opacity: 0;
}

@keyframes settings-loading-spin {
  to { transform: rotate(360deg); }
}
</style>
