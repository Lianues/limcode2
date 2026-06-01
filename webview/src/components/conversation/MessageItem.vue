<script setup lang="ts">
import { computed } from 'vue';
import type { MessageRecord } from '@shared/protocol';
import RichContentView from '@webview/components/content/RichContentView.vue';

const props = defineProps<{
  message: MessageRecord;
}>();

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : '助手'));
const streaming = computed(() => props.message.status === 'streaming');
</script>

<template>
  <article class="message" :class="message.role">
    <div class="message-meta">{{ roleLabel }}</div>
    <div class="message-bubble">
      <RichContentView :parts="message.content.parts" :streaming="streaming" />
    </div>
  </article>
</template>

<style scoped>
.message {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-width: 100%;
}

.message.user {
  align-items: flex-end;
}

.message-meta {
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
}

.message-bubble {
  max-width: 90%;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  background: var(--vscode-editor-background);
}

/* 用户消息用中性微底色区分，不使用蓝紫强调色。 */
.message.user .message-bubble {
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
}
</style>
