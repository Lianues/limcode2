<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconTool } from '@tabler/icons-vue';
import type { FunctionCallPart, ToolCallRecord, ToolCallStatus, ToolSchedulingMode } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { bridge, BridgeMessageType } from '@webview/transport';
import ContentBlockSection from '../ContentBlockSection.vue';
import CollapsibleContentBlock from '../CollapsibleContentBlock.vue';

const props = defineProps<{
  part: FunctionCallPart;
  messageId?: string;
  batchIndex?: number;
  batchMode?: ToolSchedulingMode;
  batchState?: 'active' | 'completed' | 'pending';
  batchPosition?: 'single' | 'first' | 'middle' | 'last';
  batchSize?: number;
  activeBatchIndex?: number;
  batchColorIndex?: number;
}>();

const clientState = useClientStateStore();
const expanded = ref(false);
const toolCall = computed<ToolCallRecord | undefined>(() => {
  const partId = props.part.id;
  if (!props.messageId || !partId) return undefined;
  return clientState.toolCalls.find(
    (call) => call.messageId === props.messageId && (call.id === partId || call.functionCallId === partId)
  );
});
const argsText = computed(() => stringifyValue(props.part.functionCall.args));
const hasArgs = computed(() => {
  const text = argsText.value.trim();
  return Boolean(text && text !== '{}');
});
const outputText = computed(() => {
  const result = toolCall.value?.result;
  if (result !== undefined) return stringifyToolResult(result);
  const progress = toolCall.value?.progress;
  if (isInternalApprovalProgress(progress)) return '';
  return progress !== undefined ? stringifyValue(progress) : '';
});
const hasOutput = computed(() => Boolean(outputText.value.trim()));
const executionApproved = computed(() => isExecutionApprovedProgress(toolCall.value?.progress));
const needsExecutionDecision = computed(() => toolCall.value?.status === 'awaiting_approval' && !executionApproved.value);
const needsApplyDecision = computed(() => toolCall.value?.status === 'awaiting_apply');
const hasDetails = computed(() => hasArgs.value || hasOutput.value || Boolean(toolCall.value?.error) || needsExecutionDecision.value || needsApplyDecision.value || executionApproved.value);
const statusLabel = computed(() => toolCall.value ? labelForToolCall(toolCall.value) : '工具请求已生成');
const statusTitle = computed(() => toolCall.value ? `工具状态：${toolCall.value.status}` : '等待后端创建工具调用记录');
const durationLabel = computed(() => {
  const duration = toolCall.value?.durationMs;
  if (duration === undefined) return undefined;
  return duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)}s`;
});
const hasBatchMeta = computed(() => props.batchIndex !== undefined && props.batchMode !== undefined && props.batchState !== undefined);
const batchModeLabel = computed(() => props.batchMode === 'parallel' ? '并行批次' : '串行批次');
const batchStateLabel = computed(() => {
  switch (props.batchState) {
    case 'active': return '当前执行';
    case 'completed': return '已完成';
    case 'pending': return '等待中';
    default: return '';
  }
});
const batchTitle = computed(() => {
  if (!hasBatchMeta.value) return undefined;
  const active = props.activeBatchIndex ? `当前批次：B${props.activeBatchIndex}` : '当前批次：无';
  return `B${props.batchIndex} · ${batchModeLabel.value} · ${batchStateLabel.value} · ${active}`;
});
const toggleLabel = computed(() => {
  if (!hasDetails.value) return `工具调用 ${props.part.functionCall.name}`;
  return expanded.value ? '收起工具调用内容' : '展开工具调用内容';
});

watch(
  () => toolCall.value?.status,
  (status) => {
    if (status === 'awaiting_approval' || status === 'awaiting_apply') expanded.value = true;
  },
  { immediate: true }
);

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringifyToolResult(value: unknown): string {
  if (isRecord(value) && typeof value.output === 'string') {
    return stringifyPossiblyJson(value.output);
  }
  return stringifyValue(value);
}

function stringifyPossiblyJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sendToolDecision(type: BridgeMessageType.ToolExecutionApprove | BridgeMessageType.ToolExecutionReject | BridgeMessageType.ToolResultApply | BridgeMessageType.ToolResultReject): void {
  const call = toolCall.value;
  if (!call) return;
  bridge.request(type, { toolCallId: call.id, conversationId: clientState.currentConversationId });
}

function labelForToolCall(call: ToolCallRecord): string {
  if (call.status === 'awaiting_approval' && isExecutionApprovedProgress(call.progress)) return '已批准，等待前序批次';
  if (call.status === 'error' && isDeniedResult(call.result)) {
    return deniedStatusLabel(call.result, call.error);
  }
  if (call.status === 'success' && isAsyncAgentRunResult(call.result)) return '子任务已启动';
  return labelForStatus(call.status);
}

function labelForStatus(status: ToolCallStatus): string {
  const labels: Record<ToolCallStatus, string> = {
    streaming: '正在生成工具调用',
    queued: '等待调度执行',
    awaiting_approval: '等待批准执行',
    executing: '工具执行中',
    awaiting_apply: '等待应用结果',
    success: '工具执行成功',
    warning: '执行完成（有警告）',
    error: '工具执行失败'
  };
  return labels[status];
}

function isDeniedResult(result: unknown): boolean {
  return isRecord(result) && result.denied === true;
}

function deniedStatusLabel(result: unknown, error: string | undefined): string {
  const reason = isRecord(result) && typeof result.reason === 'string' ? result.reason : error ?? '';
  if (reason.includes('应用')) return '已拒绝应用结果';
  if (reason.includes('执行')) return '已拒绝执行';
  return '已拒绝工具调用';
}

function isAsyncAgentRunResult(result: unknown): boolean {
  return isRecord(result) && result.status === 'async_launched';
}

function isExecutionApprovedProgress(progress: unknown): boolean {
  return isRecord(progress) && progress.executionApproved === true;
}

function isWaitingForPreviousProgress(progress: unknown): boolean {
  return isRecord(progress) && progress.waitingForPrevious === true;
}

function isInternalApprovalProgress(progress: unknown): boolean {
  if (!isRecord(progress) || progress.executionApproved !== true) return false;
  return Object.keys(progress).every((key) => key === 'executionApproved' || key === 'waitingForPrevious');
}
</script>

<template>
  <CollapsibleContentBlock
    v-model:expanded="expanded"
    class="tool-call-card"
    :class="[
      toolCall ? `status-${toolCall.status}` : undefined,
      hasBatchMeta ? `batch-${batchState}` : undefined,
      hasBatchMeta ? `batch-pos-${batchPosition}` : undefined,
      hasBatchMeta ? `batch-mode-${batchMode}` : undefined,
      hasBatchMeta ? `batch-color-${batchColorIndex ?? 1}` : undefined
    ]"
    kind="input"
    :collapsible="hasDetails"
    :aria-label="toggleLabel"
    :title="batchTitle"
  >
    <template #icon>
      <IconTool stroke="2" aria-hidden="true" />
    </template>
    <template #summary>
      <span class="part-card-name">{{ part.functionCall.name }}</span>
    </template>
    <template #trail>
      <span class="part-card-status" :title="statusTitle">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="part-card-meta">{{ durationLabel }}</span>
    </template>

    <div class="part-card-details">
      <ContentBlockSection v-if="hasArgs" kind="input" title="输入" :text="argsText" />
      <ContentBlockSection v-if="hasOutput" kind="output" title="输出" :text="outputText" />
      <p v-if="toolCall?.error" class="part-card-error">{{ toolCall.error }}</p>
      <div v-if="needsExecutionDecision" class="tool-decision-actions">
        <button type="button" @click="sendToolDecision(BridgeMessageType.ToolExecutionApprove)">批准执行</button>
        <button type="button" class="secondary" @click="sendToolDecision(BridgeMessageType.ToolExecutionReject)">拒绝</button>
      </div>
      <div v-else-if="needsApplyDecision" class="tool-decision-actions">
        <button type="button" @click="sendToolDecision(BridgeMessageType.ToolResultApply)">应用结果</button>
        <button type="button" class="secondary" @click="sendToolDecision(BridgeMessageType.ToolResultReject)">拒绝应用</button>
      </div>
      <p v-else-if="executionApproved && isWaitingForPreviousProgress(toolCall?.progress)" class="part-card-note">
        已批准执行，将在前序批次完成后按原始顺序自动继续。
      </p>
    </div>
  </CollapsibleContentBlock>
</template>

<style scoped>
.tool-call-card {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  font-style: normal;
  --tool-batch-color: transparent;
}

.tool-call-card.batch-color-1 { --tool-batch-color: #6a9955; }
.tool-call-card.batch-color-2 { --tool-batch-color: #c5863a; }
.tool-call-card.batch-color-3 { --tool-batch-color: #b5cea8; }
.tool-call-card.batch-color-4 { --tool-batch-color: #ce9178; }
.tool-call-card.batch-color-5 { --tool-batch-color: #4ec9b0; }

.tool-call-card.batch-color-1 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-2 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-3 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-4 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-5 :deep(.lc-collapsible-summary) {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--tool-batch-color) 78%, var(--vscode-editor-background) 22%);
}

.tool-call-card.batch-active :deep(.lc-collapsible-summary) {
  box-shadow: inset 4px 0 0 var(--tool-batch-color);
  border-color: color-mix(in srgb, var(--vscode-panel-border) 62%, var(--tool-batch-color) 38%);
}

.tool-call-card.batch-pending :deep(.lc-collapsible-summary) {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--tool-batch-color) 38%, transparent);
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 62%, var(--vscode-editor-background) 38%);
}

.tool-call-card.batch-completed :deep(.lc-collapsible-summary) {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--tool-batch-color) 52%, transparent);
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, var(--vscode-editor-background) 30%);
}

.tool-call-card.batch-pending :deep(.lc-collapsible-summary:hover),
.tool-call-card.batch-pending :deep(.lc-collapsible-summary:focus-visible),
.tool-call-card.batch-completed :deep(.lc-collapsible-summary:hover),
.tool-call-card.batch-completed :deep(.lc-collapsible-summary:focus-visible) {
  color: var(--vscode-foreground);
}

.tool-call-card.batch-pos-middle,
.tool-call-card.batch-pos-last {
  margin-top: calc(-1 * var(--space-1));
}

.part-card-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: inherit;
}

.part-card-status,
.part-card-meta {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.part-card-details {
  margin: 3px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-decision-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.tool-decision-actions button {
  min-height: 26px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
}

.tool-decision-actions button:hover,
.tool-decision-actions button:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}


.part-card-error {
  margin: 6px 0 0;
  color: var(--vscode-errorForeground);
}

.part-card-note {
  margin: 0;
  color: var(--vscode-descriptionForeground);
}

.part-card-error:first-child {
  margin-top: 0;
}

.status-success .part-card-status {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.status-warning .part-card-status {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.status-error .part-card-status {
  color: var(--vscode-errorForeground);
}
</style>
