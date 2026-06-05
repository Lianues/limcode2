<script setup lang="ts">
import { computed } from 'vue';
import type { FileDataPart } from '@shared/protocol';

const props = defineProps<{
  part: FileDataPart;
}>();

const mimeType = computed(() => props.part.fileData.mimeType || '未知类型');
</script>

<template>
  <section class="file-card">
    <div class="file-title">文件附件</div>
    <div class="file-meta">{{ mimeType }}</div>
    <div class="file-uri">{{ part.fileData.uri }}</div>
  </section>
</template>

<style scoped>
.file-card {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.file-title {
  font-weight: 600;
}

.file-meta,
.file-uri {
  margin-top: 4px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.file-uri {
  word-break: break-all;
}
</style>
