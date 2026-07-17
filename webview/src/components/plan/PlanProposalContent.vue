<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconClipboardList, IconCircleCheck, IconCircleX, IconPencilMinus } from '@tabler/icons-vue';
import { submitPlanOutputFromResult } from '@shared/planReview';
import type { PlanProposalRecord, PlanProposalStatus, SubmitPlanToolRequestRecord, ToolCallRecord } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { bridge, BridgeMessageType } from '@webview/transport';
import TextPartView from '@webview/components/content/parts/TextPartView.vue';

const props = defineProps<{
  request: SubmitPlanToolRequestRecord;
  proposalId?: string;
  toolCall?: ToolCallRecord;
}>();

const clientState = useClientStateStore();
const submitting = ref<undefined | 'approve' | 'changes' | 'reject'>(undefined);
const output = computed(() => submitPlanOutputFromResult(props.toolCall?.result));
const proposal = computed<PlanProposalRecord | undefined>(() => {
  const id = props.proposalId ?? output.value?.proposalId;
  if (!id) return undefined;
  return clientState.planProposals.find((item) => item.id === id);
});
const status = computed<PlanProposalStatus>(() => output.value?.status ?? proposal.value?.status ?? (props.toolCall?.status === 'awaiting_user_input' ? 'pending' : 'pending'));
const pending = computed(() => props.toolCall?.status === 'awaiting_user_input' && status.value === 'pending');
const title = computed(() => props.request.title ?? proposal.value?.title ?? output.value?.title ?? 'Plan');
const planBody = computed(() => props.request.plan || proposal.value?.body || output.value?.plan || '');
const risks = computed(() => props.request.risks ?? proposal.value?.risks ?? output.value?.risks ?? []);
const files = computed(() => props.request.files ?? proposal.value?.files ?? output.value?.files ?? []);
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
const userMessage = computed(() => output.value?.userMessage);

watch(
  () => `${props.toolCall?.id ?? ''}:${props.toolCall?.status ?? ''}:${status.value}`,
  () => {
    if (!pending.value) submitting.value = undefined;
  },
  { immediate: true }
);

function decide(kind: 'approve' | 'changes' | 'reject'): void {
  const toolCallId = props.toolCall?.id;
  const planProposalId = props.proposalId ?? output.value?.proposalId;
  if (!toolCallId || !planProposalId || !pending.value || submitting.value) return;
  submitting.value = kind;
  bridge.request(messageTypeForDecision(kind), {
    toolCallId,
    planProposalId,
    ...(clientState.currentConversationId ? { conversationId: clientState.currentConversationId } : {}),
    message: defaultMessageForDecision(kind)
  });
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
  if (kind === 'approve') return '用户已批准 Plan，可以继续执行。';
  if (kind === 'changes') return '用户要求修改 Plan。请根据反馈调整后重新提交 Plan。';
  return '用户拒绝 Plan。';
}
</script>

<template>
  <section class="plan-proposal" :class="[`tone-${statusTone}`, { 'is-pending': pending }]" :aria-label="statusLabel">
    <header class="plan-proposal-heading">
      <IconClipboardList class="plan-proposal-heading-icon" stroke="2" aria-hidden="true" />
      <span class="plan-proposal-heading-main">{{ title }}</span>
      <span class="plan-proposal-status">{{ statusLabel }}</span>
    </header>

    <div class="plan-proposal-body">
      <TextPartView :text="planBody" markdown />
    </div>

    <div v-if="risks.length || files.length" class="plan-proposal-meta-grid">
      <section v-if="risks.length" class="plan-proposal-meta-block">
        <h4>风险 / 注意点</h4>
        <ul>
          <li v-for="(risk, index) in risks" :key="`risk-${index}-${risk}`">{{ risk }}</li>
        </ul>
      </section>
      <section v-if="files.length" class="plan-proposal-meta-block">
        <h4>涉及文件 / 区域</h4>
        <ul>
          <li v-for="(file, index) in files" :key="`file-${index}-${file}`">{{ file }}</li>
        </ul>
      </section>
    </div>

    <p v-if="userMessage && !pending" class="plan-proposal-message">{{ userMessage }}</p>

    <footer v-if="pending" class="plan-proposal-actions">
      <button type="button" class="plan-action secondary" :disabled="!!submitting" @click="decide('reject')">
        <IconCircleX class="plan-action-icon" stroke="2" aria-hidden="true" />
        <span>{{ submitting === 'reject' ? '正在拒绝…' : '拒绝' }}</span>
      </button>
      <button type="button" class="plan-action secondary" :disabled="!!submitting" @click="decide('changes')">
        <IconPencilMinus class="plan-action-icon" stroke="2" aria-hidden="true" />
        <span>{{ submitting === 'changes' ? '正在提交…' : '要求修改' }}</span>
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

.plan-proposal-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.plan-proposal-meta-block {
  min-width: 0;
  border: 1px solid var(--vscode-panel-border);
  padding: 8px;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.plan-proposal-meta-block h4 {
  margin: 0 0 6px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.plan-proposal-meta-block ul {
  margin: 0;
  padding-left: 18px;
}

.plan-proposal-meta-block li + li {
  margin-top: 4px;
}

.plan-proposal-message {
  margin: 0;
  color: var(--vscode-descriptionForeground);
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

@media (max-width: 640px) {
  .plan-proposal-meta-grid {
    grid-template-columns: 1fr;
  }
}
</style>
