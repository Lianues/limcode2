<script setup lang="ts">
import { ref } from 'vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const scroller = ref<HTMLElement | null>(null);

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
    <div class="lc-content-block-section-scroll-shell">
      <div ref="scroller" class="lc-content-block-section-scroll">
        <pre v-if="text !== undefined" class="lc-content-block-section-code">{{ text }}</pre>
        <div v-else class="lc-content-block-section-body"><slot /></div>
      </div>
      <AdvancedScrollbar class="lc-content-block-section-scrollbar" :scroller="scroller" />
    </div>
  </section>
</template>

<style scoped>
.lc-content-block-section {
  padding: 8px 10px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  color: var(--vscode-descriptionForeground);
  background: var(--lc-content-input-background);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  font-size: var(--font-size-sm);
  min-height: 0;
  overflow: hidden;
}

.lc-content-block-section.is-input,
.lc-content-block-section.is-output {
  background: var(--lc-content-input-background);
}

.lc-content-block-section-title {
  flex: 0 0 auto;
  margin: 0 0 6px;
  padding-bottom: 5px;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 24%, transparent);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.lc-content-block-section-scroll-shell {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  max-height: var(--lc-content-block-section-max-height);
  overflow: hidden;
}

.lc-content-block-section-scroll {
  width: 100%;
  min-height: 0;
  max-height: var(--lc-content-block-section-max-height);
  overflow: auto;
  padding-right: 12px;
  scrollbar-width: none;
  box-sizing: border-box;
}

.lc-content-block-section-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.lc-content-block-section-code {
  margin: 0;
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

.lc-content-block-section :deep(.advanced-scrollbar.lc-content-block-section-scrollbar) {
  top: 0;
  right: 0;
  bottom: 0;
  width: 9px;
  z-index: 2;
  opacity: 0.72;
}

.lc-content-block-section :deep(.advanced-scrollbar.lc-content-block-section-scrollbar.is-hidden) {
  opacity: 0;
  pointer-events: none;
}

.lc-content-block-section :deep(.lc-content-block-section-scrollbar .scroll-track) {
  min-height: 24px;
  border-color: transparent;
  background: transparent;
}

.lc-content-block-section :deep(.lc-content-block-section-scrollbar .scroll-thumb) {
  left: 2px;
  right: 2px;
  min-height: 20px;
  border: 0;
  background: color-mix(in srgb, var(--vscode-foreground) 42%, transparent);
}
</style>
