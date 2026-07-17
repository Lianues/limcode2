import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { createSubmitPlanToolOutput, normalizeSubmitPlanToolRequest } from '../../../../../shared/planReview';
import { SUBMIT_PLAN_TOOL_NAME, type PlanProposalStatus, type SubmitPlanDecisionStatus } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { runForToolCall, toolCallEntityById } from '../../agentRun/queries';
import { InFlight } from '../../chat/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../../tools/bundles';
import { ToolCall, ToolState, type ToolCallData } from '../../tools/components';
import { transitionToolState } from '../../tools/state';
import { PlanProposal, RunPlanProposalLink, type PlanProposalData } from '../components';
import { PlanReviewEventType } from '../events';
import { PlanReviewBundle } from '../bundles';

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
      || readEvents(ctx, PlanReviewEventType.ProposalRejectRequested).length > 0;
  },
  access: {
    queries: [PlanDecisionLookupQuery],
    bundles: [ToolCallEventBundle, PlanReviewBundle],
    events: {
      read: [
        PlanReviewEventType.ProposalApproveRequested,
        PlanReviewEventType.ProposalChangesRequested,
        PlanReviewEventType.ProposalRejectRequested
      ]
    }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, PlanReviewEventType.ProposalApproveRequested)) {
      completePlanDecision(world, cmd, payload.toolCallId, payload.planProposalId, 'approved', payload.message);
    }
    for (const payload of readEvents(ctx, PlanReviewEventType.ProposalChangesRequested)) {
      completePlanDecision(world, cmd, payload.toolCallId, payload.planProposalId, 'change_requested', payload.message);
    }
    for (const payload of readEvents(ctx, PlanReviewEventType.ProposalRejectRequested)) {
      completePlanDecision(world, cmd, payload.toolCallId, payload.planProposalId, 'rejected', payload.message);
    }
  }
});

function completePlanDecision(
  world: WorldReader,
  cmd: CommandSink,
  toolCallId: string,
  planProposalId: string,
  status: SubmitPlanDecisionStatus,
  userMessage: string | undefined
): void {
  const toolCall = toolCallEntityById(world, toolCallId);
  const proposalEntity = findPlanProposalById(world, planProposalId);
  if (toolCall === undefined || proposalEntity === undefined) return;

  const call = world.get(toolCall, ToolCall);
  const state = world.get(toolCall, ToolState);
  const proposal = world.get(proposalEntity, PlanProposal);
  if (!call || !state || !proposal || call.name !== SUBMIT_PLAN_TOOL_NAME || state.status !== 'awaiting_user_input') return;
  if (!proposalBelongsToToolRun(world, toolCall, proposalEntity)) return;
  if (proposal.status !== 'pending') return;

  const now = Date.now();
  const durationMs = Math.max(0, now - call.createdAt);
  const message = normalizedDecisionMessage(status, userMessage);
  const request = requestFromCallOrProposal(call, proposal);
  const output = createSubmitPlanToolOutput({
    proposalId: proposal.id,
    status,
    request,
    ...(message ? { userMessage: message } : {})
  });

  cmd.add(proposalEntity, PlanProposal, {
    ...proposal,
    status: status as PlanProposalStatus,
    updatedAt: now
  });

  if (status === 'rejected') {
    const reason = message || '用户拒绝 Plan。';
    const result = { ok: false, output, denied: true, reason };
    cmd.add(toolCall, ToolState, transitionToolState(state, 'error', { error: reason, result, durationMs }, now));
    cmd.remove(toolCall, InFlight);
    spawnToolCallEvent(cmd, {
      toolCall,
      toolCallId: call.id,
      kind: 'failed',
      status: 'error',
      at: now,
      elapsedMs: durationMs,
      durationMs,
      payload: output,
      error: reason
    });
    return;
  }

  const result = { ok: true, output };
  cmd.add(toolCall, ToolState, transitionToolState(state, 'success', { result, durationMs }, now));
  cmd.remove(toolCall, InFlight);
  spawnToolCallEvent(cmd, {
    toolCall,
    toolCallId: call.id,
    kind: 'completed',
    status: 'success',
    at: now,
    elapsedMs: durationMs,
    durationMs,
    payload: output
  });
}

function requestFromCallOrProposal(call: ToolCallData, proposal: PlanProposalData) {
  try {
    return normalizeSubmitPlanToolRequest(call.argsJson);
  } catch {
    return {
      ...(proposal.title ? { title: proposal.title } : {}),
      plan: proposal.body,
      ...(proposal.risks && proposal.risks.length > 0 ? { risks: [...proposal.risks] } : {}),
      ...(proposal.files && proposal.files.length > 0 ? { files: [...proposal.files] } : {})
    };
  }
}

function proposalBelongsToToolRun(world: WorldReader, toolCall: Entity, planProposal: Entity): boolean {
  const run = runForToolCall(world, toolCall);
  if (run === undefined) return false;
  return world.query(RunPlanProposalLink).some((entity) => {
    const link = world.get(entity, RunPlanProposalLink);
    return !!link && link.run === run && link.planProposal === planProposal && link.role === 'active';
  });
}

function findPlanProposalById(world: WorldReader, id: string): Entity | undefined {
  const normalized = id.trim();
  if (!normalized) return undefined;
  return world.query(PlanProposal).find((entity) => world.get(entity, PlanProposal)?.id === normalized);
}

function normalizedDecisionMessage(status: SubmitPlanDecisionStatus, value: string | undefined): string | undefined {
  const text = value?.trim();
  if (text) return text;
  if (status === 'approved') return '用户已批准 Plan，可以继续执行。';
  if (status === 'change_requested') return '用户要求修改 Plan。请根据反馈调整并重新提交 Plan。';
  return '用户拒绝 Plan。';
}
