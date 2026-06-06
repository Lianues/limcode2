<script setup lang="ts">
import { computed } from 'vue';
import type { FunctionResponsePart } from '@shared/protocol';

const props = defineProps<{
  part: FunctionResponsePart;
}>();

const responseText = computed(() => stringifyValue(props.part.functionResponse.response));

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
</script>

<template>
  <section class="part-card function-response-card">
    <header class="part-card-header">
      <span class="part-card-title">工具响应</span>
      <span class="part-card-name">{{ part.functionResponse.name }}</span>
    </header>
    <pre v-if="responseText" class="part-card-code">{{ responseText }}</pre>
  </section>
</template>

<style scoped>
.part-card {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  background: var(--lc-content-output-background);
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.part-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.part-card-title {
  color: var(--vscode-descriptionForeground);
  flex: 0 0 auto;
}

.part-card-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.part-card-code {
  margin: 6px 0 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
}
</style>
