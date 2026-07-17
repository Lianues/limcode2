<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { IconClipboardList, IconCircleCheck, IconCircleX, IconPencilMinus } from '@tabler/icons-vue';
import { submitPlanOutputFromResult } from '@shared/planReview';
import type { PlanProposalRecord, PlanProposalStatus, SubmitPlanToolRequestRecord, ToolCallRecord } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { bridge, BridgeMessageType } from '@webview/transport';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import TextPartView from '@webview/components/content/parts/TextPartView.vue';
import TaskListDisplay from '@webview/components/taskList/TaskListDisplay.vue';
import { taskListDisplayItemsFromOperation } from '@webview/components/taskList/taskListModel';

const props = defineProps<{
  request: SubmitPlanToolRequestRecord;
  proposalId?: string;
  toolCall?: ToolCallRecord;
}>();

const MAX_PLAN_FEEDBACK_LENGTH = 4_000;

const clientState = useClientStateStore();
const submitting = ref<undefined | 'approve' | 'changes' | 'reject'>(undefined);
const changeFeedbackOpen = ref(false);
const changeFeedbackText = ref('');
const changeFeedbackInput = ref<HTMLTextAreaElement | null>(null);
const output = computed(() => submitPlanOutputFromResult(props.toolCall?.result));
const proposal = computed<PlanProposalRecord | undefined>(() => {
  const id = props.proposalId ?? output.value?.proposalId;
  if (!id) return undefined;
  return clientState.planProposals.find((item) => item.id === id);
});
const status = computed<PlanProposalStatus>(() => output.value?.status ?? proposal.value?.status ?? (props.toolCall?.status === 'awaiting_user_input' ? 'pending' : 'pending'));
const pending = computed(() => props.toolCall?.status === 'awaiting_user_input' && status.value === 'pending');
const planBody = computed(() => props.request.plan || proposal.value?.body || '');
const taskListOperation = computed(() => props.request.taskList ?? proposal.value?.taskList);
const taskListItems = computed(() => taskListOperation.value ? taskListDisplayItemsFromOperation(taskListOperation.value) : []);
const taskListTitle = computed(() => taskListOperation.value?.mode === 'update' ? '任务清单更新' : '任务清单');
const statusLabel = computed(() => {
  if (submitting.value === 'approve') return '正在批准 Plan';
  if (submitting.value === 'changes') return '正在提交修改要求';
  if (submitting.value === 'reject') return '正在拒绝 Plan';
  if (props.toolCall?.status === 'error' && status.value === 'pending') return 'Plan 已取消';
  switch (status.value) {
    case 'pending': return '等待你审批';
    case 'approved': return 'Plan 已批准';
    case 'change_requested': return '已要求修改 Plan';
    case 'rejected': return 'Plan 已拒绝';
  }
});
const statusTone = computed(() => {
  if (props.toolCall?.status === 'error' && status.value === 'pending') return 'rejected';
  switch (status.value) {
    case 'approved': return 'approved';
    case 'change_requested': return 'changes';
    case 'rejected': return 'rejected';
    default: return 'pending';
  }
});
const userMessage = computed(() => localizedUserMessage(output.value?.userMessage));
const feedbackInputId = computed(() => `plan-feedback-input-${props.toolCall?.id ?? props.proposalId ?? 'current'}`);

watch(
  () => props.toolCall?.id ?? '',
  () => {
    submitting.value = undefined;
    changeFeedbackOpen.value = false;
    changeFeedbackText.value = '';
  }
);

watch(
  () => `${props.toolCall?.id ?? ''}:${props.toolCall?.status ?? ''}:${status.value}`,
  () => {
    if (!pending.value) {
      submitting.value = undefined;
      changeFeedbackOpen.value = false;
      changeFeedbackText.value = '';
    }
  },
  { immediate: true }
);

function decide(kind: 'approve' | 'changes' | 'reject', message = defaultMessageForDecision(kind)): void {
  const toolCallId = props.toolCall?.id;
  const planProposalId = props.proposalId ?? output.value?.proposalId;
  if (!toolCallId || !planProposalId || !pending.value || submitting.value) return;
  const userMessage = message.trim() || defaultMessageForDecision(kind);
  submitting.value = kind;
  bridge.request(messageTypeForDecision(kind), {
    toolCallId,
    planProposalId,
    ...(clientState.currentConversationId ? { conversationId: clientState.currentConversationId } : {}),
    message: userMessage
  });
}

function openChangeFeedback(): void {
  if (!pending.value || submitting.value) return;
  changeFeedbackOpen.value = true;
  void nextTick(() => changeFeedbackInput.value?.focus());
}

function updateChangeFeedback(event: Event): void {
  const target = event.target as HTMLTextAreaElement | null;
  changeFeedbackText.value = target?.value ?? '';
}

function submitChangeFeedback(): void {
  if (!changeFeedbackOpen.value) {
    openChangeFeedback();
    return;
  }
  decide('changes', changeFeedbackText.value.trim() || defaultMessageForDecision('changes'));
}

function messageTypeForDecision(kind: 'approve' | 'changes' | 'reject'):
  | BridgeMessageType.PlanProposalApprove
  | BridgeMessageType.PlanProposalRequestChanges
  | BridgeMessageType.PlanProposalReject {
  if (kind === 'approve') return BridgeMessageType.PlanProposalApprove;
  if (kind === 'changes') return BridgeMessageType.PlanProposalRequestChanges;
  return BridgeMessageType.PlanProposalReject;
}

function defaultMessageForDecision(kind: 'approve' | 'changes' | 'reject'): string {
  if (kind === 'approve') return 'User approved the plan. Continue with the approved plan.';
  if (kind === 'changes') return 'User requested changes to the plan. Revise the plan and submit it again.';
  return 'User rejected the plan.';
}

function localizedUserMessage(message: string | undefined): string | undefined {
  const text = message?.trim();
  if (!text) return undefined;
  if (text === defaultMessageForDecision('approve')) return '用户已批准 Plan，可以继续执行。';
  if (text === defaultMessageForDecision('changes')) return '用户要求修改 Plan，请调整后重新提交。';
  if (text === defaultMessageForDecision('reject')) return '用户已拒绝 Plan。';
  return text;
}

</script>

<template>
  <section class="plan-proposal" :class="[`tone-${statusTone}`, { 'is-pending': pending }]" :aria-label="statusLabel">
    <header class="plan-proposal-heading">
      <IconClipboardList class="plan-proposal-heading-icon" stroke="2" aria-hidden="true" />
      <span class="plan-proposal-heading-main">Plan</span>
      <span class="plan-proposal-status">{{ statusLabel }}</span>
    </header>

    <div class="plan-proposal-body">
      <TextPartView :text="planBody" markdown />
    </div>

    <section v-if="taskListItems.length" class="plan-proposal-task-list">
      <h4>{{ taskListTitle }}</h4>
      <TaskListDisplay
        :items="taskListItems"
        density="normal"
        :show-change="taskListOperation?.mode === 'update'"
        empty-text="Plan 未提供任务清单。"
      />
    </section>

    <p v-if="userMessage && !pending" class="plan-proposal-message">{{ userMessage }}</p>

    <div v-if="pending && changeFeedbackOpen" class="plan-feedback">
      <label class="plan-feedback-label" :for="feedbackInputId">修改要求</label>
      <div class="plan-feedback-input-shell">
        <textarea
          :id="feedbackInputId"
          ref="changeFeedbackInput"
          class="plan-feedback-input"
          :value="changeFeedbackText"
          :disabled="!!submitting"
          rows="3"
          :maxlength="MAX_PLAN_FEEDBACK_LENGTH"
          placeholder="说明希望 AI 如何修改 Plan；留空则仅告知 AI 需要重新调整。Ctrl/Cmd + Enter 提交"
          aria-label="Plan 修改要求"
          @input="updateChangeFeedback"
          @keydown.ctrl.enter.prevent="submitChangeFeedback"
          @keydown.meta.enter.prevent="submitChangeFeedback"
        ></textarea>
        <AdvancedScrollbar
          class="plan-feedback-scrollbar"
          :scroller="changeFeedbackInput"
          :refresh-key="changeFeedbackText"
          variant="minimal"
        />
      </div>
      <p class="plan-feedback-hint">反馈会作为工具结果回传给 AI，AI 应根据反馈重新提交 Plan。</p>
    </div>

    <footer v-if="pending" class="plan-proposal-actions">
      <button type="button" class="plan-action secondary" :disabled="!!submitting" @click="decide('reject')">
        <IconCircleX class="plan-action-icon" stroke="2" aria-hidden="true" />
        <span>{{ submitting === 'reject' ? '正在拒绝…' : '拒绝' }}</span>
      </button>
      <button type="button" class="plan-action secondary" :disabled="!!submitting" @click="submitChangeFeedback">
        <IconPencilMinus class="plan-action-icon" stroke="2" aria-hidden="true" />
        <span>{{ submitting === 'changes' ? '正在提交…' : changeFeedbackOpen ? '提交修改要求' : '要求修改' }}</span>
      </button>
      <button type="button" class="plan-action primary" :disabled="!!submitting" @click="decide('approve')">
        <IconCircleCheck class="plan-action-icon" stroke="2" aria-hidden="true" />
        <span>{{ submitting === 'approve' ? '正在批准…' : '批准' }}</span>
      </button>
    </footer>
  </section>
</template>

<style scoped>
.plan-proposal {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.plan-proposal-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.plan-proposal-heading-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
}

.plan-proposal-heading-main {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.plan-proposal-status {
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tone-approved .plan-proposal-status {
  border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 42%, var(--vscode-panel-border));
  color: var(--vscode-testing-iconPassed, #73c991);
}

.tone-changes .plan-proposal-status {
  border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 42%, var(--vscode-panel-border));
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.tone-rejected .plan-proposal-status {
  border-color: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 42%, var(--vscode-panel-border));
  color: var(--vscode-errorForeground, #f48771);
}

.plan-proposal-body {
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 78%, var(--vscode-foreground) 22%);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.plan-proposal-task-list {
  min-width: 0;
  border: 1px solid var(--vscode-panel-border);
  padding: 8px;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.plan-proposal-task-list h4 {
  margin: 0 0 8px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.plan-proposal-message {
  margin: 0;
  color: var(--vscode-descriptionForeground);
}

.plan-feedback {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.plan-feedback-label {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.plan-feedback-input-shell {
  position: relative;
  min-width: 0;
}

.plan-feedback-input {
  width: 100%;
  min-height: 72px;
  max-height: 180px;
  resize: vertical;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 78%, var(--vscode-foreground) 22%);
  background: var(--vscode-input-background, var(--vscode-editor-background));
  color: var(--vscode-input-foreground, var(--vscode-foreground));
  font: inherit;
  line-height: 1.5;
  outline: none;
  scrollbar-width: none;
}

.plan-feedback-input::-webkit-scrollbar {
  display: none;
}

.plan-feedback-input:focus {
  border-color: color-mix(in srgb, var(--vscode-focusBorder) 45%, var(--vscode-panel-border));
}

.plan-feedback-input:disabled {
  opacity: 0.65;
}

.plan-feedback-scrollbar {
  position: absolute;
  top: 4px;
  right: 3px;
  bottom: 4px;
}

.plan-feedback-hint {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.plan-proposal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.plan-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  font: inherit;
  cursor: pointer;
}

.plan-action.primary {
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
  color: var(--vscode-foreground);
  border-color: color-mix(in srgb, var(--vscode-foreground) 34%, var(--vscode-panel-border));
}

.plan-action:hover:not(:disabled),
.plan-action:focus-visible:not(:disabled) {
  border-color: color-mix(in srgb, var(--vscode-focusBorder) 42%, var(--vscode-panel-border));
  background: color-mix(in srgb, var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)) 72%, var(--vscode-editor-background) 28%);
}

.plan-action.primary:hover:not(:disabled),
.plan-action.primary:focus-visible:not(:disabled) {
  background: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-foreground) 28%);
}

.plan-action:disabled {
  cursor: default;
  opacity: 0.58;
}

.plan-action-icon {
  width: 15px;
  height: 15px;
}

</style>
