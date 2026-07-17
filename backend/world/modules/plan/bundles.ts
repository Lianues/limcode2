import { defineBundle, type CommandSink, type Entity, type WorldReader } from '../../../ecs/types';
import type {
  PlanProposalRecord,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeKind,
  PlanReviewRequiredToolRiskLevel
} from '../../../../shared/protocol';
import {
  PlanProposal,
  PlanReviewPolicy,
  PlanReviewPolicyScopeLink,
  RunPlanProposalLink,
  type PlanProposalData,
  type PlanReviewPolicyData,
  type PlanReviewPolicyScopeLinkData
} from './components';

export const PlanReviewBundle = defineBundle({
  name: 'PlanReviewBundle',
  writes: [PlanReviewPolicy, PlanReviewPolicyScopeLink, PlanProposal, RunPlanProposalLink],
  mutationMode: 'update',
  spawns: true,
  despawns: true
});

export function normalizePlanReviewPolicy(input: Partial<PlanReviewPolicyRecord> & { id: string }): PlanReviewPolicyRecord {
  const now = Date.now();
  const riskLevels = normalizeRequiredRiskLevels(input.requireForToolRiskLevels);
  return {
    id: input.id,
    mode: input.mode === 'before_mutation' ? 'before_mutation' : 'off',
    allowReadonlyBeforeApproval: input.allowReadonlyBeforeApproval !== false,
    requireForToolRiskLevels: riskLevels.length > 0 ? riskLevels : ['write', 'command', 'agent'],
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now
  };
}

export function upsertPlanReviewPolicy(
  world: WorldReader,
  cmd: CommandSink,
  input: Partial<PlanReviewPolicyData> & { id: string }
): Entity {
  const existing = findPlanReviewPolicyById(world, input.id);
  const previous = existing !== undefined ? world.get(existing, PlanReviewPolicy) : undefined;
  const now = Date.now();
  const next = normalizePlanReviewPolicy({ ...(previous ?? {}), ...input, updatedAt: now });
  if (existing !== undefined) {
    cmd.add(existing, PlanReviewPolicy, next);
    return existing;
  }
  const entity = cmd.spawn();
  cmd.add(entity, PlanReviewPolicy, next);
  return entity;
}

export function upsertPlanReviewPolicyScopeLink(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    scopeKind: PlanReviewPolicyScopeKind;
    scopeId?: string;
    policy: Entity;
    data: Partial<{ workflow: Entity; agent: Entity; conversation: Entity; run: Entity }>;
  }
): Entity {
  const now = Date.now();
  const existing = findActivePlanReviewPolicyScopeLink(world, input.scopeKind, input.scopeId);
  if (existing) {
    cmd.add(existing.entity, PlanReviewPolicyScopeLink, {
      ...existing.link,
      planReviewPolicy: input.policy,
      ...input.data,
      updatedAt: now
    });
    return existing.entity;
  }

  const entity = cmd.spawn();
  cmd.add(entity, PlanReviewPolicyScopeLink, {
    id: planReviewPolicyScopeLinkId(input.scopeKind, input.scopeId),
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    planReviewPolicy: input.policy,
    ...input.data,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function upsertPlanProposal(
  world: WorldReader,
  cmd: CommandSink,
  input: Omit<PlanProposalRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<PlanProposalRecord, 'createdAt' | 'updatedAt'>>
): Entity {
  const existing = findPlanProposalById(world, input.id);
  const previous = existing !== undefined ? world.get(existing, PlanProposal) : undefined;
  const now = Date.now();
  const next: PlanProposalData = {
    id: input.id,
    ...(input.title ? { title: input.title } : {}),
    body: input.body,
    ...(input.risks && input.risks.length > 0 ? { risks: [...input.risks] } : {}),
    ...(input.files && input.files.length > 0 ? { files: [...input.files] } : {}),
    status: input.status,
    createdAt: previous?.createdAt ?? input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
  if (existing !== undefined) {
    cmd.add(existing, PlanProposal, next);
    return existing;
  }
  const entity = cmd.spawn();
  cmd.add(entity, PlanProposal, next);
  return entity;
}

export function linkPlanProposalToRun(
  world: WorldReader,
  cmd: CommandSink,
  input: { run: Entity; runId: string; planProposal: Entity; planProposalId: string }
): Entity {
  const existing = world
    .query(RunPlanProposalLink)
    .map((entity) => ({ entity, link: world.get(entity, RunPlanProposalLink) }))
    .find((item) => !!item.link && item.link.run === input.run && item.link.planProposal === input.planProposal && item.link.role === 'active');
  if (existing) return existing.entity;

  const now = Date.now();
  const entity = cmd.spawn();
  cmd.add(entity, RunPlanProposalLink, {
    id: runPlanProposalLinkId(input.runId, input.planProposalId),
    run: input.run,
    planProposal: input.planProposal,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function findPlanReviewPolicyById(world: WorldReader, id: string): Entity | undefined {
  return world.query(PlanReviewPolicy).find((entity) => world.get(entity, PlanReviewPolicy)?.id === id);
}

export function findPlanProposalById(world: WorldReader, id: string): Entity | undefined {
  return world.query(PlanProposal).find((entity) => world.get(entity, PlanProposal)?.id === id);
}

function findActivePlanReviewPolicyScopeLink(
  world: WorldReader,
  scopeKind: PlanReviewPolicyScopeKind,
  scopeId: string | undefined
): { entity: Entity; link: PlanReviewPolicyScopeLinkData } | undefined {
  const normalizedScopeId = scopeKind === 'global' ? undefined : scopeId?.trim();
  return world
    .query(PlanReviewPolicyScopeLink)
    .map((entity) => ({ entity, link: world.get(entity, PlanReviewPolicyScopeLink) }))
    .filter((item): item is { entity: Entity; link: PlanReviewPolicyScopeLinkData } =>
      !!item.link && item.link.role === 'active' && item.link.scopeKind === scopeKind && (scopeKind === 'global' ? item.link.scopeId === undefined : item.link.scopeId === normalizedScopeId)
    )
    .sort((left, right) => right.link.updatedAt - left.link.updatedAt || right.link.createdAt - left.link.createdAt || right.entity - left.entity)[0];
}

function planReviewPolicyScopeLinkId(scopeKind: PlanReviewPolicyScopeKind, scopeId: string | undefined): string {
  return scopeKind === 'global'
    ? 'plan-review-policy-link:global'
    : `plan-review-policy-link:${scopeKind}:${scopeId ?? 'unknown'}`;
}

function runPlanProposalLinkId(runId: string, planProposalId: string): string {
  return `run-plan-proposal:${runId}:${planProposalId}`;
}

function normalizeRequiredRiskLevels(value: unknown): PlanReviewRequiredToolRiskLevel[] {
  if (!Array.isArray(value)) return [];
  const result: PlanReviewRequiredToolRiskLevel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item !== 'write' && item !== 'command' && item !== 'agent') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}
