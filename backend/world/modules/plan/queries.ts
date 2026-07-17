import type { Entity, WorldReader } from '../../../ecs/types';
import type { PlanReviewPolicyRecord, PlanReviewPolicyScopeKind, PlanReviewRequiredToolRiskLevel } from '../../../../shared/protocol';
import { Agent } from '../agent/components';
import { agentTypeEntityForRuntimeAgent } from '../agent/identity';
import { AgentRun } from '../agentRun/components';
import { activeWorkflowForRun, activeWorkflowSelectionForConversation, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { Workflow } from '../workflow/components';
import {
  PlanProposal,
  PlanReviewPolicy,
  PlanReviewPolicyScopeLink,
  RunPlanProposalLink,
  type PlanProposalData,
  type PlanReviewPolicyScopeLinkData
} from './components';
import { normalizePlanReviewPolicy } from './bundles';

export interface PlanReviewPolicyResolution {
  policy: PlanReviewPolicyRecord;
  policyEntity?: Entity;
  link?: PlanReviewPolicyScopeLinkData;
  inheritedFrom?: PlanReviewPolicyScopeKind | 'fallback';
}

export function effectivePlanReviewPolicyForRun(world: WorldReader, run: Entity): PlanReviewPolicyResolution {
  const runLocal = localPlanReviewPolicyForScopeEntity(world, 'run', run);
  if (runLocal.policy) return runLocal as PlanReviewPolicyResolution;

  const workflow = activeWorkflowForRun(world, run);
  if (workflow !== undefined) {
    const workflowPolicy = localPlanReviewPolicyForScopeEntity(world, 'workflow', workflow);
    if (workflowPolicy.policy) return { ...workflowPolicy, inheritedFrom: 'workflow' } as PlanReviewPolicyResolution;
  }

  const target = runTarget(world, run);
  if (target) {
    const conversationPolicy = localPlanReviewPolicyForScopeEntity(world, 'conversation', target.conversation);
    if (conversationPolicy.policy) return { ...conversationPolicy, inheritedFrom: 'conversation' } as PlanReviewPolicyResolution;
    const agentPolicy = localPlanReviewPolicyForScopeEntity(world, 'agent', agentTypeEntityForRuntimeAgent(world, target.agent));
    if (agentPolicy.policy) return { ...agentPolicy, inheritedFrom: 'agent' } as PlanReviewPolicyResolution;
  }

  const global = localPlanReviewPolicyForScope(world, 'global');
  if (global.policy) return { ...global, inheritedFrom: 'global' } as PlanReviewPolicyResolution;

  return { policy: fallbackPlanReviewPolicy(), inheritedFrom: 'fallback' };
}

export function effectivePlanReviewPolicyForConversation(world: WorldReader, conversation: Entity): PlanReviewPolicyResolution {
  const selectedWorkflow = activeWorkflowSelectionForConversation(world, conversation);
  if (selectedWorkflow?.scopeKind === 'workflow') {
    const workflowPolicy = localPlanReviewPolicyForScopeEntity(world, 'workflow', selectedWorkflow.workflow);
    if (workflowPolicy.policy) return { ...workflowPolicy, inheritedFrom: 'workflow' } as PlanReviewPolicyResolution;
  }

  const local = localPlanReviewPolicyForScopeEntity(world, 'conversation', conversation);
  if (local.policy) return local as PlanReviewPolicyResolution;

  const global = localPlanReviewPolicyForScope(world, 'global');
  if (global.policy) return { ...global, inheritedFrom: 'global' } as PlanReviewPolicyResolution;

  return { policy: fallbackPlanReviewPolicy(), inheritedFrom: 'fallback' };
}

export function hasApprovedPlanForRun(world: WorldReader, run: Entity): boolean {
  return world.query(RunPlanProposalLink).some((entity) => {
    const link = world.get(entity, RunPlanProposalLink);
    if (!link || link.run !== run || link.role !== 'active') return false;
    return world.get(link.planProposal, PlanProposal)?.status === 'approved';
  });
}

export function latestPlanProposalForRun(world: WorldReader, run: Entity): { entity: Entity; proposal: PlanProposalData } | undefined {
  let selected: { entity: Entity; proposalEntity: Entity; proposal: PlanProposalData; linkCreatedAt: number; linkId: string } | undefined;
  for (const entity of world.query(RunPlanProposalLink)) {
    const link = world.get(entity, RunPlanProposalLink);
    if (!link || link.run !== run || link.role !== 'active') continue;
    const proposal = world.get(link.planProposal, PlanProposal);
    if (!proposal) continue;
    const candidate = { entity, proposalEntity: link.planProposal, proposal, linkCreatedAt: link.createdAt, linkId: link.id };
    if (!selected
      || candidate.proposal.createdAt > selected.proposal.createdAt
      || (candidate.proposal.createdAt === selected.proposal.createdAt && candidate.linkCreatedAt > selected.linkCreatedAt)
      || (candidate.proposal.createdAt === selected.proposal.createdAt && candidate.linkCreatedAt === selected.linkCreatedAt && candidate.linkId > selected.linkId)
    ) selected = candidate;
  }
  return selected ? { entity: selected.proposalEntity, proposal: selected.proposal } : undefined;
}

export function localPlanReviewPolicyForScope(
  world: WorldReader,
  scopeKind: PlanReviewPolicyScopeKind,
  scopeId?: string
): Partial<PlanReviewPolicyResolution> {
  const normalizedScopeId = scopeKind === 'global' ? undefined : scopeId?.trim();
  const matches = world
    .query(PlanReviewPolicyScopeLink)
    .map((entity) => ({ entity, link: world.get(entity, PlanReviewPolicyScopeLink) }))
    .filter((item): item is { entity: Entity; link: PlanReviewPolicyScopeLinkData } =>
      !!item.link && item.link.role === 'active' && item.link.scopeKind === scopeKind && (scopeKind === 'global' ? item.link.scopeId === undefined : scopeIdForLink(world, item.link) === normalizedScopeId)
    )
    .sort((left, right) => right.link.updatedAt - left.link.updatedAt || right.link.createdAt - left.link.createdAt || right.entity - left.entity);
  const selected = matches[0];
  const policy = selected ? world.get(selected.link.planReviewPolicy, PlanReviewPolicy) : undefined;
  return {
    ...(policy ? { policy, policyEntity: selected?.link.planReviewPolicy } : {}),
    ...(selected?.link ? { link: selected.link } : {})
  };
}

export function planReviewRequiresRiskLevel(policy: PlanReviewPolicyRecord, riskLevel: PlanReviewRequiredToolRiskLevel): boolean {
  return policy.mode === 'before_mutation' && policy.requireForToolRiskLevels.includes(riskLevel);
}

function localPlanReviewPolicyForScopeEntity(world: WorldReader, scopeKind: PlanReviewPolicyScopeKind, scopeEntity: Entity | undefined): Partial<PlanReviewPolicyResolution> {
  if (scopeEntity === undefined) return {};
  return localPlanReviewPolicyForScope(world, scopeKind, recordIdForScopeEntity(world, scopeKind, scopeEntity));
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

function recordIdForScopeEntity(world: WorldReader, scopeKind: PlanReviewPolicyScopeKind, entity: Entity): string | undefined {
  switch (scopeKind) {
    case 'global': return undefined;
    case 'conversation': return world.get(entity, Conversation)?.id;
    case 'agent': return world.get(entity, Agent)?.id;
    case 'workflow': return world.get(entity, Workflow)?.id;
    case 'run': return world.get(entity, AgentRun)?.id;
  }
}

function fallbackPlanReviewPolicy(): PlanReviewPolicyRecord {
  return normalizePlanReviewPolicy({
    id: 'plan-review-policy:fallback',
    mode: 'off',
    allowReadonlyBeforeApproval: true,
    requireForToolRiskLevels: ['write', 'command', 'agent']
  });
}
