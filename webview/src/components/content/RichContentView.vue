<script setup lang="ts">
import { computed } from 'vue';
import type { ContentPart } from '@shared/protocol';
import { partViewComponent, toRenderNodes, type RichRenderNode } from './partRegistry';

const props = defineProps<{
  parts: ContentPart[];
  streaming?: boolean;
  markdown?: boolean;
  messageId?: string;
}>();

const nodes = computed(() => toRenderNodes(props.parts));

function nodeStreaming(node: RichRenderNode, index: number): boolean {
  if (!props.streaming || index !== nodes.value.length - 1) return false;
  if (node.kind === 'thought') return node.props.thoughtOpen === true;
  return node.kind === 'text';
}
</script>

<template>
  <div class="rich-content">
    <template v-if="nodes.length">
      <component
        :is="partViewComponent(node.kind)"
        v-for="(node, index) in nodes"
        :key="node.key"
        v-bind="node.props"
        :message-id="messageId"
        :markdown="markdown"
        :streaming="nodeStreaming(node, index)"
      />
    </template>
    <!-- 流式中但还没有任何内容块：渲染一个仅含光标的空文本节点。 -->
    <component
      :is="partViewComponent('text')"
      v-else-if="streaming"
      :text="''"
      :markdown="markdown"
      :streaming="true"
    />
  </div>
</template>

<style scoped>
.rich-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
</style>
