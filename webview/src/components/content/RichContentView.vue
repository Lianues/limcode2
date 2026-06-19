<script setup lang="ts">
import { computed } from 'vue';
import {
  isFunctionCallPart,
  type ContentPart,
  type FunctionCallPart,
  type ToolCallRecord,
  type ToolSchedulingMode
} from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { partViewComponent, toRenderNodes, type RichRenderNode } from './partRegistry';

const props = defineProps<{
  parts: ContentPart[];
  streaming?: boolean;
  markdown?: boolean;
  messageId?: string;
}>();

interface ToolBatchMeta {
  batchIndex: number;
  batchMode: ToolSchedulingMode;
  batchState: 'active' | 'completed' | 'pending';
  batchPosition: 'single' | 'first' | 'middle' | 'last';
  batchSize: number;
  activeBatchIndex?: number;
  batchColorIndex: number;
}

interface ToolCallNodeInfo {
  nodeIndex: number;
  call?: ToolCallRecord;
  mode: ToolSchedulingMode;
  blocking: boolean;
}

const clientState = useClientStateStore();
const nodes = computed(() => withToolBatchMeta(toRenderNodes(props.parts)));

function nodeStreaming(node: RichRenderNode, index: number): boolean {
  if (!props.streaming || index !== nodes.value.length - 1) return false;
  if (node.kind === 'thought') return node.props.thoughtOpen === true;
  return node.kind === 'text';
}

function withToolBatchMeta(inputNodes: RichRenderNode[]): RichRenderNode[] {
  const result = inputNodes.map((node) => ({ ...node, props: { ...node.props } }));
  let segment: ToolCallNodeInfo[] = [];

  const flushSegment = (): void => {
    if (segment.length === 0) return;
    applyBatchMeta(result, segment);
    segment = [];
  };

  for (let index = 0; index < result.length; index += 1) {
    const node = result[index]!;
    if (node.kind === 'functionCall') {
      const call = toolCallForNode(node);
      segment.push({
        nodeIndex: index,
        call,
        mode: call?.schedulingMode ?? 'serial',
        blocking: call ? isBlockingToolCall(call) : true
      });
      continue;
    }
    flushSegment();
  }
  flushSegment();

  return result;
}

function applyBatchMeta(nodesToUpdate: RichRenderNode[], segment: ToolCallNodeInfo[]): void {
  const batches: ToolCallNodeInfo[][] = [];
  for (const item of segment) {
    const current = batches[batches.length - 1];
    if (current && item.mode === 'parallel' && current[0]?.mode === 'parallel') {
      current.push(item);
    } else {
      batches.push([item]);
    }
  }

  const activeBatchOffset = batches.findIndex((batch) => batch.some((item) => item.blocking));
  const activeBatchIndex = activeBatchOffset >= 0 ? activeBatchOffset + 1 : undefined;

  batches.forEach((batch, batchOffset) => {
    const batchIndex = batchOffset + 1;
    const batchState: ToolBatchMeta['batchState'] = activeBatchIndex === undefined
      ? 'completed'
      : batchIndex < activeBatchIndex
        ? 'completed'
        : batchIndex === activeBatchIndex
          ? 'active'
          : 'pending';

    batch.forEach((item, positionIndex) => {
      const position = batch.length === 1
        ? 'single'
        : positionIndex === 0
          ? 'first'
          : positionIndex === batch.length - 1
            ? 'last'
            : 'middle';
      Object.assign(nodesToUpdate[item.nodeIndex]!.props, {
        batchIndex,
        batchMode: batch[0]!.mode,
        batchState,
        batchPosition: position,
        batchSize: batch.length,
        batchColorIndex: colorIndexForBatch(batchIndex),
        ...(activeBatchIndex !== undefined ? { activeBatchIndex } : {})
      } satisfies ToolBatchMeta);
    });
  });
}

function colorIndexForBatch(batchIndex: number): number {
  return ((batchIndex - 1) % 5) + 1;
}

function toolCallForNode(node: RichRenderNode): ToolCallRecord | undefined {
  if (!props.messageId) return undefined;
  const part = node.props.part;
  if (!isFunctionCallPart(part as ContentPart)) return undefined;
  const functionCallPart = part as FunctionCallPart;
  const partId = functionCallPart.id;
  if (!partId) return undefined;
  return clientState.toolCalls.find(
    (call) => call.messageId === props.messageId && (call.id === partId || call.functionCallId === partId)
  );
}

function isBlockingToolCall(call: ToolCallRecord): boolean {
  return call.status === 'streaming'
    || call.status === 'queued'
    || call.status === 'awaiting_approval'
    || call.status === 'executing'
    || call.status === 'awaiting_change_apply'
    || call.status === 'applying_change'
    || call.status === 'change_applied'
    || call.status === 'change_rejected'
    || call.status === 'awaiting_result_submit';
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
