<script setup lang="ts">
import { computed, nextTick, ref, useAttrs, watch } from 'vue';
import { IconArrowsMaximize, IconArrowsMinimize, IconClipboardList, IconCircleCheck, IconCircleX, IconDownload, IconMessage2, IconMessagePlus, IconPencilMinus, IconRobot } from '@tabler/icons-vue';
import { renderPlanMarkdown } from '@shared/planMarkdown';
import { DELEGATED_PLAN_APPROVAL_MESSAGE, submitPlanOutputFromResult } from '@shared/planReview';
import type { AgentRecord, PlanProposalRecord, PlanProposalStatus, SubmitPlanToolRequestRecord, ToolCallRecord } from '@shared/protocol';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { bridge, BridgeMessageType } from '@webview/transport';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import TextPartView from '@webview/components/content/parts/TextPartView.vue';
import TaskListDisplay from '@webview/components/taskList/TaskListDisplay.vue';
import { taskListDisplayItemsFromOperation } from '@webview/components/taskList/taskListModel';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  request: SubmitPlanToolRequestRecord;
  proposalId?: string;
  toolCall?: ToolCallRecord;
  layout?: 'embedded' | 'full';
}>(), {
  layout: 'embedded'
});

const emit = defineEmits<{
  (event: 'panel-expanded-change', value: boolean): void;
}>();

const MAX_PLAN_FEEDBACK_LENGTH = 4_000;

const attrs = useAttrs();
const clientState = useClientStateStore();
const agentStore = useAgentStore();
const submitting = ref<undefined | 'approve-current' | 'approve-new' | 'changes' | 'reject'>(undefined);
const changeFeedbackOpen = ref(false);
const dispatchPanelOpen = ref(false);
const selectedDispatchAgentType = ref('');
const changeFeedbackText = ref('');
const changeFeedbackInput = ref<HTMLTextAreaElement | null>(null);
const planScroller = ref<HTMLElement | null>(null);
const panelExpanded = ref(false);
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
const canTogglePanelExpanded = computed(() => props.layout === 'embedded');
const scrollRefreshKey = computed(() => [
  planBody.value.length,
  taskListItems.value.map((item) => `${item.key}:${item.status}:${item.title}:${item.description ?? ''}`).join('|'),
  changeFeedbackOpen.value ? changeFeedbackText.value : '',
  userMessage.value ?? '',
  pending.value ? 'pending' : 'settled',
  submitting.value ?? '',
  props.layout,
  panelExpanded.value ? 'expanded' : 'normal'
].join('::'));
const statusLabel = computed(() => {
  if (submitting.value === 'approve-current') return '正在批准 Plan';
  if (submitting.value === 'approve-new') return '正在分派 Plan';
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
const delegatedExecution = computed(() => output.value?.executionTarget === 'new_conversation' ? output.value : undefined);
const dispatchAgentOptions = computed<SettingsDropdownOption[]>(() => agentStore.configurableAgents.map((agent) => ({
  value: agent.id,
  label: agent.name,
  description: agent.description || agentTypeDescription(agent),
  icon: IconRobot
})));
const selectedDispatchAgent = computed<AgentRecord | undefined>(() => agentStore.configurableAgents.find((agent) => agent.id === selectedDispatchAgentType.value));
const dispatchPanelActions = computed<ConfirmPanelAction[]>(() => [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '分派执行', disabled: !selectedDispatchAgent.value }
]);
const feedbackInputId = computed(() => `plan-feedback-input-${props.toolCall?.id ?? props.proposalId ?? 'current'}`);
const exportMarkdown = computed(() => renderPlanMarkdown({
  plan: planBody.value,
  ...(taskListOperation.value ? { taskList: taskListOperation.value } : {}),
  statusLabel: statusLabel.value,
  taskListTitle: taskListTitle.value
}));
const exportSuggestedFileName = computed(() => `plan-${clientState.currentConversation?.title || props.proposalId || output.value?.proposalId || 'export'}.md`);

watch(
  () => props.toolCall?.id ?? '',
  () => {
    submitting.value = undefined;
    changeFeedbackOpen.value = false;
    changeFeedbackText.value = '';
    dispatchPanelOpen.value = false;
    selectedDispatchAgentType.value = '';
    panelExpanded.value = false;
    emit('panel-expanded-change', false);
  }
);

watch(
  () => `${props.toolCall?.id ?? ''}:${props.toolCall?.status ?? ''}:${status.value}`,
  () => {
    if (!pending.value) {
      submitting.value = undefined;
      changeFeedbackOpen.value = false;
      changeFeedbackText.value = '';
      dispatchPanelOpen.value = false;
    }
  },
  { immediate: true }
);

function approveInCurrentConversation(): void {
  submitApproval('current_conversation');
}

function openDispatchPanel(): void {
  if (!pending.value || submitting.value) return;
  const available = agentStore.configurableAgents;
  const current = available.find((agent) => agent.id === selectedDispatchAgentType.value);
  const preferred = current
    ?? available.find((agent) => agent.id === 'worker')
    ?? available.find((agent) => agent.kind === 'worker')
    ?? available[0];
  selectedDispatchAgentType.value = preferred?.id ?? '';
  dispatchPanelOpen.value = true;
}

function closeDispatchPanel(): void {
  if (submitting.value === 'approve-new') return;
  dispatchPanelOpen.value = false;
}

function confirmDispatch(): void {
  const agent = selectedDispatchAgent.value;
  if (!agent) return;
  dispatchPanelOpen.value = false;
  submitApproval('new_conversation', agent.id);
}

function submitApproval(target: 'current_conversation' | 'new_conversation', agentType?: string): void {
  const toolCallId = props.toolCall?.id;
  const planProposalId = props.proposalId ?? output.value?.proposalId;
  if (!toolCallId || !planProposalId || !pending.value || submitting.value) return;
  const conversationId = clientState.currentConversationId.trim();
  if (target === 'new_conversation') {
    const normalizedAgentType = agentType?.trim();
    if (!normalizedAgentType) return;
    submitting.value = 'approve-new';
    bridge.request(BridgeMessageType.PlanProposalApprove, {
      toolCallId,
      planProposalId,
      ...(conversationId ? { conversationId } : {}),
      message: DELEGATED_PLAN_APPROVAL_MESSAGE,
      executionTarget: 'new_conversation',
      agentType: normalizedAgentType
    });
    return;
  }

  submitting.value = 'approve-current';
  bridge.request(BridgeMessageType.PlanProposalApprove, {
    toolCallId,
    planProposalId,
    ...(conversationId ? { conversationId } : {}),
    message: defaultMessageForDecision('approve'),
    executionTarget: 'current_conversation'
  });
}

function decide(kind: 'changes' | 'reject', message = defaultMessageForDecision(kind)): void {
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

function togglePanelExpanded(): void {
  if (!canTogglePanelExpanded.value) return;
  panelExpanded.value = !panelExpanded.value;
  emit('panel-expanded-change', panelExpanded.value);
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

function messageTypeForDecision(kind: 'changes' | 'reject'):
  | BridgeMessageType.PlanProposalRequestChanges
  | BridgeMessageType.PlanProposalReject {
  return kind === 'changes' ? BridgeMessageType.PlanProposalRequestChanges : BridgeMessageType.PlanProposalReject;
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

function exportPlan(): void {
  const markdown = exportMarkdown.value.trim();
  if (!markdown) return;
  bridge.request(BridgeMessageType.PlanProposalExport, {
    suggestedFileName: exportSuggestedFileName.value,
    markdown
  });
}

function openDelegatedConversation(): void {
  const conversationId = delegatedExecution.value?.conversationId?.trim();
  if (!conversationId) return;
  bridge.request(BridgeMessageType.ConversationOpen, { conversationId });
}

function agentTypeDescription(agent: AgentRecord): string {
  return agent.source === 'builtin' ? `内置 Agent · ${agent.kind}` : `用户 Agent · ${agent.kind}`;
}

</script>

<template>
  <section
    v-bind="attrs"
    class="plan-proposal"
    :class="[`tone-${statusTone}`, `layout-${props.layout}`, { 'is-pending': pending, 'is-panel-expanded': panelExpanded }]"
    :aria-label="statusLabel"
  >
    <header class="plan-proposal-heading">
      <IconClipboardList class="plan-proposal-heading-icon" stroke="2" aria-hidden="true" />
      <span class="plan-proposal-heading-main">Plan</span>
      <button
        v-if="canTogglePanelExpanded"
        type="button"
        class="plan-panel-expand-button"
        :aria-pressed="panelExpanded"
        :title="panelExpanded ? '收起聊天面板内的完整 Plan 视图' : '在聊天面板内完整展开 Plan 内容'"
        @click="togglePanelExpanded"
      >
        <component :is="panelExpanded ? IconArrowsMinimize : IconArrowsMaximize" class="plan-panel-expand-icon" stroke="2" aria-hidden="true" />
        <span>{{ panelExpanded ? '收起' : '展开' }}</span>
      </button>
      <span class="plan-proposal-status">{{ statusLabel }}</span>
      <button type="button" class="plan-export-button" aria-label="导出 Plan Markdown" @click="exportPlan">
        <IconDownload class="plan-export-button-icon" stroke="2" aria-hidden="true" />
        <span>导出</span>
      </button>
    </header>

    <div class="plan-proposal-scroll-shell">
      <div ref="planScroller" class="plan-proposal-scroll">
        <div class="plan-proposal-body">
          <TextPartView :text="planBody" markdown />
        </div>

        <section v-if="taskListItems.length" class="plan-proposal-task-list">
          <h4>{{ taskListTitle }}</h4>
          <TaskListDisplay
            :items="taskListItems"
            density="normal"
            :show-change="taskListOperation?.mode === 'update'"
            :wrap="props.layout === 'full'"
            empty-text="Plan 未提供任务清单。"
          />
        </section>

        <p v-if="userMessage && !pending" class="plan-proposal-message">{{ userMessage }}</p>

        <section v-if="delegatedExecution && !pending" class="plan-delegation-result" aria-label="Plan 分派信息">
          <header class="plan-delegation-heading">
            <IconRobot stroke="2" aria-hidden="true" />
            <span>已分派给 {{ delegatedExecution.agentType || delegatedExecution.agentId || 'Agent' }}</span>
          </header>
          <dl class="plan-delegation-metadata">
            <div v-if="delegatedExecution.runId"><dt>Run ID</dt><dd>{{ delegatedExecution.runId }}</dd></div>
            <div v-if="delegatedExecution.conversationId"><dt>Conversation ID</dt><dd>{{ delegatedExecution.conversationId }}</dd></div>
            <div v-if="delegatedExecution.answerBridgeId"><dt>Answer Bridge ID</dt><dd>{{ delegatedExecution.answerBridgeId }}</dd></div>
          </dl>
          <button
            v-if="delegatedExecution.conversationId"
            type="button"
            class="plan-open-delegated-conversation"
            @click="openDelegatedConversation"
          >
            <IconMessage2 stroke="2" aria-hidden="true" />
            <span>打开 Agent 对话</span>
          </button>
        </section>

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
      </div>
      <AdvancedScrollbar
        class="plan-proposal-scrollbar"
        :scroller="planScroller"
        :refresh-key="scrollRefreshKey"
        variant="minimal"
      />
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
      <button type="button" class="plan-action secondary" :disabled="!!submitting || !dispatchAgentOptions.length" @click="openDispatchPanel">
        <IconMessagePlus class="plan-action-icon" stroke="2" aria-hidden="true" />
        <span>{{ submitting === 'approve-new' ? '正在分派…' : '新开对话执行' }}</span>
      </button>
      <button type="button" class="plan-action primary" :disabled="!!submitting" @click="approveInCurrentConversation">
        <IconCircleCheck class="plan-action-icon" stroke="2" aria-hidden="true" />
        <span>{{ submitting === 'approve-current' ? '正在批准…' : '在当前对话中执行' }}</span>
      </button>
    </footer>
  </section>

  <ConfirmPanel
    :open="dispatchPanelOpen"
    title="选择执行 Agent"
    description="将创建所选 Agent 类型的临时镜像和独立对话，并在后台执行已批准的 Plan。"
    :actions="dispatchPanelActions"
    @cancel="closeDispatchPanel"
    @confirm="confirmDispatch"
  >
    <label class="plan-dispatch-agent-field">
      <span>Agent 类型</span>
      <SettingsDropdown
        v-model="selectedDispatchAgentType"
        :options="dispatchAgentOptions"
        title="选择执行 Agent"
        placeholder="请选择 Agent"
        searchable
        search-placeholder="筛选 Agent..."
        :max-height="240"
      />
    </label>
    <div v-if="selectedDispatchAgent" class="plan-dispatch-agent-summary">
      <IconRobot stroke="2" aria-hidden="true" />
      <span>
        <strong>{{ selectedDispatchAgent.name }}</strong>
        <small>{{ selectedDispatchAgent.description || agentTypeDescription(selectedDispatchAgent) }}</small>
      </span>
    </div>
  </ConfirmPanel>
</template>

<style scoped>
.plan-proposal {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.plan-proposal.layout-embedded {
  max-height: var(--lc-plan-proposal-max-height, min(62vh, 520px));
  overflow: hidden;
}

.plan-proposal.layout-embedded.is-panel-expanded {
  height: auto;
  max-height: none;
}

.plan-proposal.layout-full {
  height: 100%;
  max-height: none;
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

.plan-panel-expand-button {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 23px;
  padding: 2px 7px;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.plan-panel-expand-button:hover,
.plan-panel-expand-button:focus-visible {
  color: var(--vscode-foreground);
  border-color: color-mix(in srgb, var(--vscode-foreground) 28%, var(--vscode-panel-border));
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}

.plan-panel-expand-button[aria-pressed="true"] {
  color: var(--vscode-foreground);
  border-color: color-mix(in srgb, var(--vscode-foreground) 34%, var(--vscode-panel-border));
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}

.plan-panel-expand-icon {
  width: 13px;
  height: 13px;
}

.plan-proposal-status {
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.plan-export-button {
  appearance: none;
  -webkit-appearance: none;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 23px;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, var(--vscode-foreground) 14%);
  border-radius: 0;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  box-shadow: none;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.plan-export-button:hover,
.plan-export-button:focus,
.plan-export-button:focus-visible {
  outline: none;
  color: var(--vscode-foreground);
  border-color: color-mix(in srgb, var(--vscode-panel-border) 52%, var(--vscode-foreground) 48%);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 9%, transparent);
}

.plan-export-button:active {
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
}

.plan-export-button::-moz-focus-inner {
  border: 0;
}

.plan-export-button-icon {
  width: 13px;
  height: 13px;
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

.plan-proposal-scroll-shell {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
}

.plan-proposal-scroll {
  min-height: 0;
  max-height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  scrollbar-width: none;
  padding-right: 0;
}

.plan-proposal-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.plan-proposal-scrollbar {
  position: absolute;
  top: 4px;
  right: 2px;
  bottom: 4px;
}

.plan-proposal.layout-embedded.is-panel-expanded .plan-proposal-scroll-shell {
  overflow: visible;
}

.plan-proposal.layout-embedded.is-panel-expanded .plan-proposal-scroll {
  max-height: none;
  overflow: visible;
  padding-right: 0;
}

.plan-proposal.layout-embedded.is-panel-expanded .plan-proposal-scrollbar {
  display: none;
}

.plan-proposal-body {
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 78%, var(--vscode-foreground) 22%);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.plan-proposal.layout-full {
  gap: 14px;
  font-size: var(--font-size-md, 13px);
}

.plan-proposal.layout-full .plan-proposal-heading-main {
  font-size: 16px;
}

.plan-proposal.layout-full .plan-proposal-body,
.plan-proposal.layout-full .plan-proposal-task-list,
.plan-proposal.layout-full .plan-feedback {
  padding: 14px;
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

.plan-delegation-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 34%, var(--vscode-panel-border));
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.plan-delegation-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
}

.plan-delegation-heading svg,
.plan-open-delegated-conversation svg {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
}

.plan-delegation-metadata {
  display: grid;
  gap: 4px;
  margin: 0;
}

.plan-delegation-metadata > div {
  min-width: 0;
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 8px;
}

.plan-delegation-metadata dt {
  color: var(--vscode-descriptionForeground);
}

.plan-delegation-metadata dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-xs);
}

.plan-open-delegated-conversation {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 3px 8px;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.plan-open-delegated-conversation:hover,
.plan-open-delegated-conversation:focus-visible {
  outline: none;
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
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
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  align-content: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 0;
  padding: 8px;
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
  background: var(--vscode-editor-background);
  z-index: 2;
}

.plan-proposal.layout-embedded .plan-proposal-actions {
  position: sticky;
  bottom: 0;
}

.plan-action {
  appearance: none;
  -webkit-appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, var(--vscode-foreground) 18%);
  border-radius: 0;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  box-shadow: none;
  color: var(--vscode-foreground);
  font: inherit;
  cursor: pointer;
}

.plan-action.primary {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 62%, var(--vscode-foreground) 38%);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
  font-weight: 600;
}

.plan-action:hover:not(:disabled),
.plan-action:focus:not(:disabled),
.plan-action:focus-visible:not(:disabled) {
  outline: none;
  border-color: color-mix(in srgb, var(--vscode-panel-border) 48%, var(--vscode-foreground) 52%);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
}

.plan-action:active:not(:disabled) {
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
}

.plan-action:disabled {
  cursor: default;
  opacity: 0.58;
}

.plan-action::-moz-focus-inner {
  border: 0;
}

.plan-action-icon {
  width: 15px;
  height: 15px;
}

.plan-dispatch-agent-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--vscode-descriptionForeground);
}

.plan-dispatch-agent-summary {
  min-width: 0;
  margin-top: var(--space-3);
  padding: var(--space-3);
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  border: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.plan-dispatch-agent-summary > svg {
  width: 20px;
  height: 20px;
  color: var(--vscode-descriptionForeground);
}

.plan-dispatch-agent-summary > span {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.plan-dispatch-agent-summary strong,
.plan-dispatch-agent-summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-dispatch-agent-summary strong {
  color: var(--vscode-foreground);
}

.plan-dispatch-agent-summary small {
  color: var(--vscode-descriptionForeground);
}

</style>
