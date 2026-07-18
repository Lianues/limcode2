<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconClipboardList, IconExternalLink } from '@tabler/icons-vue';
import { submitPlanOutputFromResult, submitPlanRequestFromArgs } from '@shared/planReview';
import { SUBMIT_PLAN_TOOL_NAME, type SubmitPlanToolRequestRecord, type ToolCallRecord } from '@shared/protocol';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import PlanProposalContent from '@webview/components/plan/PlanProposalContent.vue';

const session = useSessionStore();
const clientState = useClientStateStore();
const scroller = ref<HTMLElement | null>(null);

const planProposalId = computed(() => session.planProposalId || proposalIdFromToolCall(toolCallById(session.toolCallId)) || '');
const proposal = computed(() => clientState.planProposals.find((item) => item.id === planProposalId.value));
const toolCall = computed(() => toolCallById(session.toolCallId) ?? toolCallForProposal(planProposalId.value));
const request = computed<SubmitPlanToolRequestRecord | undefined>(() => {
  const fromToolCall = submitPlanRequestFromArgs(toolCall.value?.args);
  if (fromToolCall) return fromToolCall;
  const currentProposal = proposal.value;
  if (!currentProposal) return undefined;
  return {
    plan: currentProposal.body,
    ...(currentProposal.taskList ? { taskList: currentProposal.taskList } : {})
  };
});
const loaded = computed(() => clientState.currentConversationDetailLoaded);
const title = computed(() => {
  if (proposal.value?.status === 'approved') return 'Plan 已批准';
  if (proposal.value?.status === 'change_requested') return 'Plan 要求修改';
  if (proposal.value?.status === 'rejected') return 'Plan 已拒绝';
  if (toolCall.value?.status === 'awaiting_user_input') return '等待审批 Plan';
  return 'Plan 详情';
});
const subtitle = computed(() => [
  clientState.currentConversation?.title || clientState.currentConversationId,
  planProposalId.value
].filter(Boolean).join(' · '));

function toolCallById(toolCallId: string): ToolCallRecord | undefined {
  const normalized = toolCallId.trim();
  if (!normalized) return undefined;
  return clientState.toolCalls.find((item) => item.id === normalized || item.functionCallId === normalized);
}

function toolCallForProposal(proposalId: string): ToolCallRecord | undefined {
  const normalized = proposalId.trim();
  if (!normalized) return undefined;
  const runLink = clientState.runPlanProposalLinks.find((item) => item.planProposalId === normalized);
  if (!runLink) return undefined;
  const candidates = clientState.toolCallRunLinks
    .filter((item) => item.runId === runLink.runId)
    .map((item) => toolCallById(item.toolCallId))
    .filter((item): item is ToolCallRecord => item?.name === SUBMIT_PLAN_TOOL_NAME);
  return candidates.find((item) => proposalIdFromToolCall(item) === normalized) ?? candidates[0];
}

function proposalIdFromToolCall(call: ToolCallRecord | undefined): string | undefined {
  if (!call || call.name !== SUBMIT_PLAN_TOOL_NAME) return undefined;
  const outputProposalId = submitPlanOutputFromResult(call.result)?.proposalId;
  if (outputProposalId) return outputProposalId;
  const progress = call.progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return undefined;
  const id = (progress as Record<string, unknown>).planProposalId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}
</script>

<template>
  <main class="plan-detail-view">
    <header class="plan-detail-head">
      <div class="plan-detail-title-wrap">
        <p class="plan-detail-kicker">Plan Review</p>
        <h1>
          <IconClipboardList class="plan-detail-title-icon" stroke="2" aria-hidden="true" />
          <span>{{ title }}</span>
        </h1>
        <p v-if="subtitle" class="plan-detail-subtitle">{{ subtitle }}</p>
      </div>
      <span class="plan-detail-badge">
        <IconExternalLink stroke="2" aria-hidden="true" />
        独立标签页
      </span>
    </header>

    <section class="plan-detail-shell">
      <div ref="scroller" class="plan-detail-scroll">
        <PlanProposalContent
          v-if="request"
          class="plan-detail-content"
          :request="request"
          :proposal-id="planProposalId || undefined"
          :tool-call="toolCall"
          layout="full"
        />
        <div v-else class="plan-detail-empty">
          <h2>{{ loaded ? '未找到 Plan' : '正在加载 Plan' }}</h2>
          <p v-if="loaded">当前标签页关联的 Plan 已不存在，或对话数据尚未包含对应工具调用。</p>
          <p v-else>正在同步当前对话的 Plan 数据，请稍候。</p>
        </div>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </section>
  </main>
</template>

<style scoped>
.plan-detail-view {
  min-width: 0;
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 18px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}

.plan-detail-head {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.plan-detail-title-wrap {
  min-width: 0;
}

.plan-detail-kicker {
  margin: 0 0 6px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  letter-spacing: .06em;
  text-transform: uppercase;
}

.plan-detail-head h1 {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--vscode-foreground);
  font-size: 20px;
  font-weight: 650;
  line-height: 1.35;
}

.plan-detail-title-icon {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
}

.plan-detail-subtitle {
  margin: 6px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.plan-detail-badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-size: var(--font-size-xs);
}

.plan-detail-badge svg {
  width: 14px;
  height: 14px;
}

.plan-detail-shell {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  margin-top: 14px;
  border: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.plan-detail-scroll {
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  scrollbar-width: none;
  padding: 18px 22px 18px 18px;
}

.plan-detail-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.plan-detail-content {
  width: 100%;
  height: 100%;
  margin: 0;
}

.plan-detail-empty {
  max-width: 620px;
  margin: 12vh auto 0;
  padding: 18px;
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
}

.plan-detail-empty h2 {
  margin: 0 0 8px;
  color: var(--vscode-foreground);
  font-size: 16px;
}

.plan-detail-empty p {
  margin: 0;
  line-height: 1.6;
}
</style>
