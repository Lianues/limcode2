<script setup lang="ts">
import { computed } from 'vue';
import type { InlineDataPart } from '@shared/protocol';

const props = defineProps<{
  part: InlineDataPart;
}>();

const mimeType = computed(() => props.part.inlineData.mimeType || 'application/octet-stream');
const dataUri = computed(() => `data:${mimeType.value};base64,${props.part.inlineData.data}`);
const kind = computed<'image' | 'audio' | 'video' | 'file'>(() => {
  if (mimeType.value.startsWith('image/')) return 'image';
  if (mimeType.value.startsWith('audio/')) return 'audio';
  if (mimeType.value.startsWith('video/')) return 'video';
  return 'file';
});
</script>

<template>
  <figure class="attachment-card" :class="`kind-${kind}`">
    <img v-if="kind === 'image'" class="attachment-image" :src="dataUri" :alt="mimeType" />
    <audio v-else-if="kind === 'audio'" class="attachment-media" :src="dataUri" controls></audio>
    <video v-else-if="kind === 'video'" class="attachment-video" :src="dataUri" controls></video>
    <figcaption class="attachment-caption">
      <span class="attachment-title">内联附件</span>
      <span class="attachment-meta">{{ mimeType }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.attachment-card {
  margin: 0;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  padding: 8px;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  color: var(--vscode-foreground);
}

.attachment-image,
.attachment-video {
  display: block;
  max-width: 100%;
  max-height: 360px;
  border-radius: var(--radius-sm);
  object-fit: contain;
}

.attachment-media {
  width: 100%;
}

.attachment-caption {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.kind-file .attachment-caption {
  margin-top: 0;
}

.attachment-title {
  font-weight: 600;
  color: var(--vscode-foreground);
}

.attachment-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
