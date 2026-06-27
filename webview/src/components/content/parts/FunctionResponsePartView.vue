<script setup lang="ts">
import { computed } from 'vue';
import type { FunctionResponsePart } from '@shared/protocol';
import ContentBlockSection from '../ContentBlockSection.vue';
import InlineDataPartView from './InlineDataPartView.vue';

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
    <ContentBlockSection v-if="responseText" kind="output" title="输出" :text="responseText" />
    <div v-if="part.functionResponse.parts?.length" class="function-response-attachments">
      <InlineDataPartView v-for="(attachment, index) in part.functionResponse.parts" :key="`${attachment.inlineData.attachmentId ?? attachment.inlineData.name ?? attachment.inlineData.mimeType}-${index}`" :part="attachment" />
    </div>
  </section>
</template>

<style scoped>
.part-card {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.part-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin: 0 0 3px;
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

.function-response-attachments {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
