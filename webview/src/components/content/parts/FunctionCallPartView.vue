<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconTool } from '@tabler/icons-vue';
import type {
  FunctionCallPart,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolCallStatus,
  ToolSchedulingMode
} from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { bridge, BridgeMessageType } from '@webview/transport';
import TaskListDisplay from '@webview/components/taskList/TaskListDisplay.vue';
import { resolveToolDisplay } from '../toolDisplay/registry';
import ContentBlockSection from '../ContentBlockSection.vue';
import CollapsibleContentBlock from '../CollapsibleContentBlock.vue';
import ToolDiffView from '../toolDisplay/ToolDiffView.vue';
import TextPartView from './TextPartView.vue';
import type { ToolHeaderAction } from '../toolDisplay/types';

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
const conversationTimeline = useConversationTimelineStore();
const expanded = ref(false);
const userChangedExpanded = ref(false);
const toolCall = computed<ToolCallRecord | undefined>(() => {
  const partId = props.part.id;
  if (!props.messageId || !partId) return undefined;
  return conversationTimeline.currentTimeline.state.toolCalls.find(
    (call) => call.messageId === props.messageId && (call.id === partId || call.functionCallId === partId)
  );
});
const toolEvents = computed<ToolCallEventRecord[]>(() => {
  const callId = toolCall.value?.id;
  if (!callId) return [];
  return clientState.toolCallEvents.filter((event) => event.toolCallId === callId).sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
});
const displayProgress = computed(() => {
  const progress = toolCall.value?.progress;
  if (isInternalApprovalProgress(progress)) return undefined;
  return progress;
});
const toolDisplay = computed(() => resolveToolDisplay({
  toolName: props.part.functionCall.name,
  args: props.part.functionCall.args,
  result: toolCall.value?.result,
  progress: displayProgress.value,
  events: toolEvents.value,
  toolCall: toolCall.value,
  messages: conversationTimeline.currentTimeline.state.messages,
  toolCalls: conversationTimeline.currentTimeline.state.toolCalls,
  agentRunSourceLinks: conversationTimeline.currentTimeline.state.agentRunSourceLinks,
  agentRunTargetLinks: conversationTimeline.currentTimeline.state.agentRunTargetLinks,
  checkpoints: conversationTimeline.currentTimeline.state.checkpoints,
  checkpointTimelineAnchors: conversationTimeline.currentTimeline.state.checkpointTimelineAnchors,
  shadowRepositories: conversationTimeline.currentTimeline.state.shadowRepositories,
  currentConversationId: clientState.currentConversationId,
  stringifyValue
}));
const inputSections = computed(() => toolDisplay.value.inputSections);
const outputSections = computed(() => toolDisplay.value.outputSections);
const toolIcon = computed(() => toolDisplay.value.headerIcon ?? IconTool);
const headerActions = computed(() => toolDisplay.value.headerActions);
const hasArgs = computed(() => inputSections.value.length > 0);
const hasOutput = computed(() => outputSections.value.length > 0);
const executionApproved = computed(() => isExecutionApprovedProgress(toolCall.value?.progress));
const needsExecutionDecision = computed(() => toolCall.value?.status === 'awaiting_approval' && !executionApproved.value);
const needsChangeApplyDecision = computed(() => toolCall.value?.status === 'awaiting_change_apply');
const needsResultSubmitDecision = computed(() => toolCall.value?.status === 'awaiting_result_submit');
const hasDetails = computed(() => hasArgs.value || hasOutput.value || Boolean(toolCall.value?.error) || executionApproved.value);
const autoExpandDetails = computed(() => toolCall.value?.display?.autoExpand === true);
const statusLabel = computed(() => toolCall.value ? labelForToolCall(toolCall.value) : '工具请求已生成');
const statusTitle = computed(() => toolCall.value ? `工具状态：${toolCall.value.status}` : '等待后端创建工具调用记录');
const durationLabel = computed(() => {
  const duration = toolCall.value?.durationMs;
  if (duration === undefined) return undefined;
  return duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)}s`;
});
const summaryLabel = computed(() => toolCall.value?.summary?.trim() || undefined);
const summaryDisplay = computed(() => {
  const summary = summaryLabel.value;
  if (!summary) return undefined;

  const lineRangeMatch = summary.match(/^(.*?)(\[L\d+(?:-\d*)?\])$/);
  return lineRangeMatch
    ? { main: lineRangeMatch[1] ?? '', suffix: lineRangeMatch[2] }
    : { main: summary };
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

watch(autoExpandDetails, (autoExpand) => {
  if (autoExpand && !userChangedExpanded.value) expanded.value = true;
}, { immediate: true });

watch(() => toolCall.value?.id, () => {
  userChangedExpanded.value = false;
  expanded.value = autoExpandDetails.value;
});

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sendToolDecision(type:
  | BridgeMessageType.ToolExecutionApprove
  | BridgeMessageType.ToolExecutionReject
  | BridgeMessageType.ToolChangeApply
  | BridgeMessageType.ToolChangeReject
  | BridgeMessageType.ToolResultSubmit
  | BridgeMessageType.ToolResultReject
): void {
  const call = toolCall.value;
  if (!call) return;
  bridge.request(type, { toolCallId: call.id, conversationId: clientState.currentConversationId });
}

function setExpanded(value: boolean): void {
  userChangedExpanded.value = true;
  expanded.value = value;
}

function invokeHeaderAction(action: ToolHeaderAction): void {
  if (action.disabled) return;
  action.invoke();
}

function labelForToolCall(call: ToolCallRecord): string {
  if (call.status === 'awaiting_approval' && isExecutionApprovedProgress(call.progress)) return '已批准，等待前序批次';
  if (call.status === 'error' && isDeniedResult(call.result)) {
    return deniedStatusLabel(call.result, call.error);
  }
  if (call.status === 'success' && isAsyncAgentRunResult(call.result)) return '子任务已启动';
  if (call.status === 'warning' && isPartialEditResult(call.result)) return '部分成功';
  return labelForStatus(call.status);
}

function labelForStatus(status: ToolCallStatus): string {
  const labels: Record<ToolCallStatus, string> = {
    streaming: '正在生成工具调用',
    queued: '等待调度执行',
    awaiting_approval: '等待批准执行',
    executing: '工具执行中',
    awaiting_change_apply: '等待应用更改',
    applying_change: '正在应用更改',
    change_applied: '更改已应用',
    change_rejected: '更改已拒绝',
    awaiting_result_submit: '等待确认结果回传',
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
  if (reason.includes('更改')) return '已拒绝更改';
  if (reason.includes('结果') || reason.includes('使用')) return '已拒绝结果';
  if (reason.includes('执行')) return '已拒绝执行';
  return '已拒绝工具调用';
}

function isAsyncAgentRunResult(result: unknown): boolean {
  return isRecord(result) && result.status === 'async_launched';
}

function isPartialEditResult(result: unknown): boolean {
  const output = toolOutput(result);
  if (!isRecord(output) || output.kind !== 'file_edit.result') return false;
  return typeof output.failed === 'number' && output.failed > 0 && typeof output.applied === 'number' && output.applied > 0;
}

function toolOutput(result: unknown): unknown {
  const record = isRecord(result) ? result : undefined;
  return record && 'output' in record ? record.output : result;
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
    :expanded="expanded"
    @update:expanded="setExpanded"
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
      <component :is="toolIcon" :stroke="2" aria-hidden="true" />
    </template>
    <template #summary>
      <span class="part-card-name" :class="{ 'has-summary': summaryLabel }">{{ part.functionCall.name }}</span>
      <span v-if="summaryDisplay" class="part-card-summary" :title="summaryLabel">
        <span class="part-card-summary-main">{{ summaryDisplay.main }}</span>
        <span v-if="summaryDisplay.suffix" class="part-card-summary-suffix">{{ summaryDisplay.suffix }}</span>
      </span>
    </template>
    <template #trail>
      <span class="part-card-status" :title="statusTitle">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="part-card-meta">{{ durationLabel }}</span>
    </template>
    <template v-if="headerActions.length > 0" #actions>
      <button
        v-for="action in headerActions"
        :key="action.id"
        type="button"
        class="tool-header-action"
        :title="action.title"
        :aria-label="action.title ?? action.label"
        :disabled="action.disabled"
        @click.stop="invokeHeaderAction(action)"
      >
        <component :is="action.icon" v-if="action.icon" class="tool-header-action-icon" :stroke="2" aria-hidden="true" />
        <span class="tool-header-action-label">{{ action.label }}</span>
      </button>
    </template>

    <div class="part-card-details">
      <ContentBlockSection
        v-for="(section, index) in inputSections"
        :key="`input-${index}-${section.title}`"
        :kind="section.kind"
        :title="section.title"
        :text="section.markdown ? undefined : section.text"
      >
        <TextPartView v-if="section.markdown && section.text !== undefined" class="tool-display-markdown" :text="section.text" markdown />
        <ToolDiffView v-if="section.diff" :diff="section.diff" />
        <div v-if="section.rows?.length" class="tool-display-rows" :class="`is-${section.rowStyle ?? 'keyValue'}`">
          <template v-for="(row, rowIndex) in section.rows" :key="`${section.title}-${rowIndex}-${row.label}`">
            <span class="tool-display-row-label">{{ row.label }}</span>
            <span class="tool-display-row-value">{{ row.value }}</span>
          </template>
        </div>
        <TaskListDisplay
          v-if="section.taskList"
          class="tool-display-task-list"
          :items="section.taskList.items"
          :show-change="section.taskList.showChange ?? false"
          :empty-text="section.taskList.emptyText"
        />
      </ContentBlockSection>
      <ContentBlockSection
        v-for="(section, index) in outputSections"
        :key="`output-${index}-${section.title}`"
        :kind="section.kind"
        :title="section.title"
        :text="section.markdown ? undefined : section.text"
      >
        <TextPartView v-if="section.markdown && section.text !== undefined" class="tool-display-markdown" :text="section.text" markdown />
        <ToolDiffView v-if="section.diff" :diff="section.diff" />
        <div v-if="section.rows?.length" class="tool-display-rows" :class="`is-${section.rowStyle ?? 'keyValue'}`">
          <template v-for="(row, rowIndex) in section.rows" :key="`${section.title}-${rowIndex}-${row.label}`">
            <span class="tool-display-row-label">{{ row.label }}</span>
            <span class="tool-display-row-value">{{ row.value }}</span>
          </template>
        </div>
        <TaskListDisplay
          v-if="section.taskList"
          class="tool-display-task-list"
          :items="section.taskList.items"
          :show-change="section.taskList.showChange ?? false"
          :empty-text="section.taskList.emptyText"
        />
      </ContentBlockSection>
      <p v-if="toolCall?.error" class="part-card-error">{{ toolCall.error }}</p>
      <p v-else-if="executionApproved && isWaitingForPreviousProgress(toolCall?.progress)" class="part-card-note">
        已批准执行，将在前序批次完成后按原始顺序自动继续。
      </p>
    </div>
  </CollapsibleContentBlock>

  <div v-if="needsExecutionDecision" class="tool-decision-actions is-external">
    <button type="button" @click="sendToolDecision(BridgeMessageType.ToolExecutionApprove)">批准执行</button>
    <button type="button" class="secondary" @click="sendToolDecision(BridgeMessageType.ToolExecutionReject)">拒绝</button>
  </div>
  <div v-else-if="needsChangeApplyDecision" class="tool-decision-actions is-external">
    <button type="button" @click="sendToolDecision(BridgeMessageType.ToolChangeApply)">应用更改</button>
    <button type="button" class="secondary" @click="sendToolDecision(BridgeMessageType.ToolChangeReject)">拒绝更改</button>
  </div>
  <div v-else-if="needsResultSubmitDecision" class="tool-decision-actions is-external">
    <button type="button" @click="sendToolDecision(BridgeMessageType.ToolResultSubmit)">回传结果给 AI</button>
    <button type="button" class="secondary" @click="sendToolDecision(BridgeMessageType.ToolResultReject)">拒绝结果并告知 AI</button>
  </div>
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

.tool-call-card :deep(.lc-collapsible-summary) {
  flex-grow: 1;
  /* 摘要区优先让出空间；工具名自身在内部保持更高优先级。 */
  flex-shrink: 999;
  flex-basis: auto;
  min-width: 0;
}

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

.part-card-name {
  min-width: 0;
  max-width: 100%;
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: inherit;
}

.part-card-summary {
  display: inline-flex;
  align-items: baseline;
  flex: 1 1 0;
  min-width: 0;
  margin-left: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
  font-size: var(--font-size-xs);
  font-weight: 400;
  opacity: 0.86;
}

.part-card-summary-main {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.part-card-summary-suffix {
  flex: 0 0 auto;
  margin-left: 4px;
  font-style: italic;
  opacity: 0.82;
}

.tool-call-card :deep(.lc-collapsible-actions) {
  flex: 0 0 auto;
  width: auto;
  min-width: max-content;
  justify-content: center;
}

.tool-call-card :deep(.lc-collapsible-trail) {
  flex: 0 0 auto;
  width: auto;
  min-width: max-content;
  display: grid;
  grid-template-columns: max-content max-content;
  align-items: center;
  column-gap: 6px;
}

.part-card-status,
.part-card-meta {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.part-card-status {
  min-width: max-content;
  overflow: visible;
  text-align: left;
  white-space: nowrap;
}

.part-card-meta {
  min-width: max-content;
  max-width: none;
  justify-self: end;
  overflow: visible;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}

.tool-header-action {
  width: auto;
  max-width: none;
  min-width: max-content;
  min-height: 22px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}

.tool-header-action:hover,
.tool-header-action:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-header-action:disabled {
  opacity: 0.5;
  cursor: default;
}

.tool-header-action-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.tool-header-action-label {
  flex: 1 1 auto;
  min-width: max-content;
  overflow: visible;
  white-space: nowrap;
}

.tool-display-rows {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: stretch;
  min-width: 0;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.tool-display-row-label,
.tool-display-row-value {
  min-width: 0;
  padding-top: 1px;
  padding-bottom: 1px;
}

.tool-display-row-label {
  padding-right: 8px;
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 82%, transparent);
  text-align: left;
  white-space: nowrap;
  user-select: none;
}

.tool-display-rows.is-lineNumber .tool-display-row-label {
  min-width: 2ch;
  text-align: right;
}

.tool-display-row-value {
  border-left: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 42%, transparent);
  padding-left: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.tool-display-task-list {
  color: var(--vscode-foreground);
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

.tool-decision-actions.is-external {
  margin: 4px 0 0 24px;
  padding-left: 0;
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
