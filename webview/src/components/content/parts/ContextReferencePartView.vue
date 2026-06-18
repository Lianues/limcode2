<script setup lang="ts">
import type { ContextReferencePart } from '@shared/protocol';

const props = defineProps<{ part: ContextReferencePart }>();
const ref = props.part.contextReference;
</script>

<template>
  <section class="context-ref-part">
    <div class="context-ref-head">
      <span class="context-ref-title">{{ ref.title || ref.conversationId }}</span>
      <span class="context-ref-pill">{{ ref.kind }} · {{ ref.mode }}</span>
    </div>
    <p class="context-ref-meta">conversation: {{ ref.conversationId }}<template v-if="ref.runId"> · run: {{ ref.runId }}</template></p>
    <pre v-if="ref.text" class="context-ref-text">{{ ref.text }}</pre>
  </section>
</template>

<style scoped>
.context-ref-part { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: var(--space-2); background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%); }
.context-ref-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.context-ref-title { font-weight: 600; }
.context-ref-pill { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.context-ref-meta { margin: var(--space-1) 0 0; color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.context-ref-text { margin: var(--space-2) 0 0; white-space: pre-wrap; color: var(--vscode-foreground); font: inherit; }
</style>
