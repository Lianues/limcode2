import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { createSubmitPlanToolOutput } from '../../../../shared/planReview';
import {
  SUBMIT_PLAN_TOOL_NAME,
  type PlanProposalStatus,
  type SubmitPlanDecisionStatus,
  type SubmitPlanDelegationStatus,
  type SubmitPlanExecutionTarget
} from '../../../../shared/protocol';
import { runForToolCall } from '../agentRun/queries';
import { InFlight } from '../chat/components';
import { spawnToolCallEvent } from '../tools/bundles';
import { ToolCall, ToolState } from '../tools/components';
import { transitionToolState } from '../tools/state';
import { PlanProposal, RunPlanProposalLink } from './components';

export interface SubmitPlanDecisionExecutionData {
  executionTarget?: SubmitPlanExecutionTarget;
  delegationStatus?: SubmitPlanDelegationStatus;
  agentId?: string;
  agentType?: string;
  runId?: string;
  conversationId?: string;
  answerBridgeId?: string;
}

export function completePlanDecision(
  world: WorldReader,
  cmd: CommandSink,
  toolCall: Entity,
  planProposalId: string,
  status: SubmitPlanDecisionStatus,
  userMessage: string | undefined,
  execution: SubmitPlanDecisionExecutionData = {}
): boolean {
  const proposalEntity = findPlanProposalById(world, planProposalId);
  if (proposalEntity === undefined) return false;

  const call = world.get(toolCall, ToolCall);
  const state = world.get(toolCall, ToolState);
  const proposal = world.get(proposalEntity, PlanProposal);
  if (!call || !state || !proposal || !isPendingPlanDecision(world, toolCall, proposalEntity)) return false;

  const now = Date.now();
  const durationMs = Math.max(0, now - call.createdAt);
  const message = normalizedDecisionMessage(status, userMessage);
  const output = createSubmitPlanToolOutput({
    proposalId: proposal.id,
    status,
    userMessage: message,
    ...execution
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
    return true;
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
  return true;
}

export function isPendingPlanDecision(world: WorldReader, toolCall: Entity, planProposal: Entity): boolean {
  const call = world.get(toolCall, ToolCall);
  const state = world.get(toolCall, ToolState);
  const proposal = world.get(planProposal, PlanProposal);
  return !!call
    && !!state
    && !!proposal
    && call.name === SUBMIT_PLAN_TOOL_NAME
    && state.status === 'awaiting_user_input'
    && proposal.status === 'pending'
    && proposalBelongsToToolRun(world, toolCall, planProposal);
}

export function proposalBelongsToToolRun(world: WorldReader, toolCall: Entity, planProposal: Entity): boolean {
  const run = runForToolCall(world, toolCall);
  return run !== undefined && proposalBelongsToRun(world, run, planProposal);
}

export function proposalBelongsToRun(world: WorldReader, run: Entity, planProposal: Entity): boolean {
  return world.query(RunPlanProposalLink).some((entity) => {
    const link = world.get(entity, RunPlanProposalLink);
    return !!link && link.run === run && link.planProposal === planProposal && link.role === 'active';
  });
}

export function findPlanProposalById(world: WorldReader, id: string): Entity | undefined {
  const normalized = id.trim();
  if (!normalized) return undefined;
  return world.query(PlanProposal).find((entity) => world.get(entity, PlanProposal)?.id === normalized);
}

function normalizedDecisionMessage(status: SubmitPlanDecisionStatus, value: string | undefined): string | undefined {
  const text = value?.trim();
  if (text) return text;
  if (status === 'approved') return 'User approved the plan. Continue with the approved plan.';
  if (status === 'change_requested') return 'User requested changes to the plan. Revise the plan and submit it again.';
  return 'User rejected the plan.';
}
