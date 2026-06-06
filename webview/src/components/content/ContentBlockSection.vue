<script setup lang="ts">
withDefaults(
  defineProps<{
    kind?: 'input' | 'output';
    title?: string;
    text?: string;
  }>(),
  { kind: 'input' }
);
</script>

<template>
  <section class="lc-content-block-section" :class="`is-${kind}`">
    <span v-if="title" class="lc-content-block-section-title">{{ title }}</span>
    <pre v-if="text !== undefined" class="lc-content-block-section-code">{{ text }}</pre>
    <div v-else class="lc-content-block-section-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.lc-content-block-section {
  padding: 8px 10px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.lc-content-block-section.is-input {
  background: var(--lc-content-input-background);
}

.lc-content-block-section.is-output {
  background: var(--lc-content-output-background);
}

.lc-content-block-section-title {
  display: block;
  margin: 0 0 4px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.lc-content-block-section-code {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.lc-content-block-section-body {
  min-width: 0;
  color: var(--vscode-descriptionForeground);
}
</style>
