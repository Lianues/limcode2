import type {
  ClientState,
  PlanProposalRecord,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeLinkRecord,
  RunPlanProposalLinkRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { Workflow } from '../workflow/components';
import {
  PlanProposal,
  PlanReviewPolicy,
  PlanReviewPolicyScopeLink,
  RunPlanProposalLink,
  type PlanReviewPolicyScopeLinkData
} from './components';

export const planReviewStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    AgentRun,
    Conversation,
    Workflow,
    PlanReviewPolicy,
    PlanReviewPolicyScopeLink,
    PlanProposal,
    RunPlanProposalLink
  ]
};

export function projectPlanReviewState(world: WorldReader): Partial<ClientState> {
  const planReviewPolicies: PlanReviewPolicyRecord[] = world.query(PlanReviewPolicy).map((entity) => ({ ...world.get(entity, PlanReviewPolicy)! }));
  const planReviewPolicyScopeLinks: PlanReviewPolicyScopeLinkRecord[] = world
    .query(PlanReviewPolicyScopeLink)
    .map((entity) => buildPlanReviewPolicyScopeLinkRecord(world, entity))
    .filter((item): item is PlanReviewPolicyScopeLinkRecord => item !== undefined);
  const planProposals: PlanProposalRecord[] = world.query(PlanProposal).map((entity) => ({ ...world.get(entity, PlanProposal)! }));
  const runPlanProposalLinks: RunPlanProposalLinkRecord[] = world
    .query(RunPlanProposalLink)
    .map((entity) => buildRunPlanProposalLinkRecord(world, entity))
    .filter((item): item is RunPlanProposalLinkRecord => item !== undefined);

  return { planReviewPolicies, planReviewPolicyScopeLinks, planProposals, runPlanProposalLinks };
}

function buildPlanReviewPolicyScopeLinkRecord(world: WorldReader, entity: number): PlanReviewPolicyScopeLinkRecord | undefined {
  const link = world.get(entity, PlanReviewPolicyScopeLink);
  if (!link) return undefined;
  const policy = world.get(link.planReviewPolicy, PlanReviewPolicy);
  if (!policy) return undefined;
  const scopeId = scopeIdForLink(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    planReviewPolicyId: policy.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildRunPlanProposalLinkRecord(world: WorldReader, entity: number): RunPlanProposalLinkRecord | undefined {
  const link = world.get(entity, RunPlanProposalLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const proposal = world.get(link.planProposal, PlanProposal);
  if (!run || !proposal) return undefined;
  return {
    id: link.id,
    runId: run.id,
    planProposalId: proposal.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function scopeIdForLink(world: WorldReader, link: PlanReviewPolicyScopeLinkData): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'workflow': return link.workflow !== undefined ? world.get(link.workflow, Workflow)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
  }
}
