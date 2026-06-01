<script setup lang="ts">
import { computed } from 'vue';
import type { ContentPart } from '@shared/protocol';
import { partViewComponent, toRenderNodes } from './partRegistry';

const props = defineProps<{
  parts: ContentPart[];
  streaming?: boolean;
}>();

const nodes = computed(() => toRenderNodes(props.parts));
</script>

<template>
  <div class="rich-content">
    <template v-if="nodes.length">
      <component
        :is="partViewComponent(node.kind)"
        v-for="(node, index) in nodes"
        :key="node.key"
        v-bind="node.props"
        :streaming="streaming && index === nodes.length - 1"
      />
    </template>
    <!-- 流式中但还没有可见内容：渲染一个仅含光标的空文本节点。 -->
    <component :is="partViewComponent('text')" v-else-if="streaming" :text="''" :streaming="true" />
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
