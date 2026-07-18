import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { SUBMIT_PLAN_TOOL_NAME } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { AgentRunTargetLink, ToolCallRunLink } from '../../agentRun/components';
import { runForToolCall, runTarget, toolCallEntityById } from '../../agentRun/queries';
import { Conversation, InFlight } from '../../chat/components';
import { ChatEventType } from '../../chat/events';
import { OpenConversationPanelIdsKey } from '../../chat/resources';
import { ToolCallEventBundle } from '../../tools/bundles';
import { ToolCall, ToolState } from '../../tools/components';
import { PlanProposal, RunPlanProposalLink } from '../components';
import { completePlanDecision, findPlanProposalById, proposalBelongsToRun } from '../decision';
import { PlanReviewEventType } from '../events';
import { PlanReviewBundle } from '../bundles';

export const BACKGROUND_SUBMIT_PLAN_AUTO_APPROVAL_MESSAGE = '当前会话标签页未打开，已根据后台策略自动批准 Plan，请继续执行。';

const PlanDecisionLookupQuery = defineQuery({
  name: 'PlanDecisionLookup',
  all: [ToolCall, ToolState],
  read: [ToolCall, ToolState, PlanProposal, RunPlanProposalLink],
  write: [ToolState, PlanProposal],
  remove: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

export const PlanProposalDecisionSystem = defineSystem({
  name: 'PlanProposalDecisionSystem',
  shouldRun(ctx) {
    return readEvents(ctx, PlanReviewEventType.ProposalApproveRequested).length > 0
      || readEvents(ctx, PlanReviewEventType.ProposalChangesRequested).length > 0
      || readEvents(ctx, PlanReviewEventType.ProposalRejectRequested).length > 0
      || readEvents(ctx, ChatEventType.ConversationPanelPresenceChanged).length > 0
      || ctx.world.query(ToolCall, ToolState).some((entity) => isAwaitingBackgroundSubmitPlanCall(ctx.world, entity));
  },
  access: {
    queries: [PlanDecisionLookupQuery],
    reads: {
      components: [ToolCallRunLink, AgentRunTargetLink, Conversation],
      resources: [OpenConversationPanelIdsKey]
    },
    bundles: [ToolCallEventBundle, PlanReviewBundle],
    events: {
      read: [
        PlanReviewEventType.ProposalApproveRequested,
        PlanReviewEventType.ProposalChangesRequested,
        PlanReviewEventType.ProposalRejectRequested,
        ChatEventType.ConversationPanelPresenceChanged
      ]
    }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const handled = new Set<Entity>();

    // 显式用户决定优先；若决定与面板关闭恰好发生在同一 tick，不用后台策略覆盖用户选择。
    for (const payload of readEvents(ctx, PlanReviewEventType.ProposalApproveRequested)) {
      if (payload.executionTarget === 'new_conversation') continue;
      const toolCall = toolCallEntityById(world, payload.toolCallId);
      if (toolCall === undefined || handled.has(toolCall)) continue;
      if (completePlanDecision(
        world,
        cmd,
        toolCall,
        payload.planProposalId,
        'approved',
        payload.message,
        { executionTarget: 'current_conversation' }
      )) handled.add(toolCall);
    }
    for (const payload of readEvents(ctx, PlanReviewEventType.ProposalChangesRequested)) {
      const toolCall = toolCallEntityById(world, payload.toolCallId);
      if (toolCall === undefined || handled.has(toolCall)) continue;
      if (completePlanDecision(world, cmd, toolCall, payload.planProposalId, 'change_requested', payload.message)) handled.add(toolCall);
    }
    for (const payload of readEvents(ctx, PlanReviewEventType.ProposalRejectRequested)) {
      const toolCall = toolCallEntityById(world, payload.toolCallId);
      if (toolCall === undefined || handled.has(toolCall)) continue;
      if (completePlanDecision(world, cmd, toolCall, payload.planProposalId, 'rejected', payload.message)) handled.add(toolCall);
    }

    for (const toolCall of world.query(ToolCall, ToolState)) {
      if (handled.has(toolCall)) continue;
      const pending = backgroundSubmitPlanApprovalForCall(world, toolCall);
      if (!pending) continue;
      if (completePlanDecision(
        world,
        cmd,
        toolCall,
        pending.planProposalId,
        'approved',
        BACKGROUND_SUBMIT_PLAN_AUTO_APPROVAL_MESSAGE,
        { executionTarget: 'current_conversation' }
      )) {
        handled.add(toolCall);
      }
    }
  }
});

export function isAwaitingBackgroundSubmitPlanCall(world: WorldReader, toolCall: Entity): boolean {
  return backgroundSubmitPlanApprovalForCall(world, toolCall) !== undefined;
}

function backgroundSubmitPlanApprovalForCall(
  world: WorldReader,
  toolCall: Entity
): { planProposalId: string } | undefined {
  const call = world.get(toolCall, ToolCall);
  const state = world.get(toolCall, ToolState);
  if (!call || !state || call.name !== SUBMIT_PLAN_TOOL_NAME || state.status !== 'awaiting_user_input') return undefined;

  const progress = state.progress && typeof state.progress === 'object' && !Array.isArray(state.progress)
    ? state.progress as Record<string, unknown>
    : undefined;
  const planProposalId = typeof progress?.planProposalId === 'string' ? progress.planProposalId.trim() : '';
  if (progress?.waitingFor !== 'plan_review' || !planProposalId) return undefined;

  const run = runForToolCall(world, toolCall);
  const proposalEntity = findPlanProposalById(world, planProposalId);
  const proposal = proposalEntity === undefined ? undefined : world.get(proposalEntity, PlanProposal);
  if (run === undefined || proposalEntity === undefined || proposal?.status !== 'pending') return undefined;
  if (!proposalBelongsToRun(world, run, proposalEntity)) return undefined;

  const openConversationIds = world.tryGetResource(OpenConversationPanelIdsKey);
  if (!openConversationIds) return undefined;
  // 主/子 Agent 统一按自己的目标 conversation 标签页判定；来源/父对话不代替该 Agent 审批。
  const target = runTarget(world, run);
  if (!target) return undefined;
  const conversationId = world.get(target.conversation, Conversation)?.id;
  if (!conversationId || openConversationIds.includes(conversationId)) return undefined;
  return { planProposalId };
}
