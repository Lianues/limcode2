import { defineSystem, type ComponentType, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Workflow } from '../../workflow/components';
import type { PlanReviewPolicyScopeKind, PlanReviewRequiredToolRiskLevel } from '../../../../../shared/protocol';
import { PlanReviewPolicy, PlanReviewPolicyScopeLink, type PlanReviewPolicyScopeLinkData } from '../components';
import { normalizePlanReviewPolicy } from '../bundles';
import { PlanReviewEventType } from '../events';

export const PlanReviewPolicyScopeSystem = defineSystem({
  name: 'PlanReviewPolicyScopeSystem',
  shouldRun(ctx) {
    return readEvents(ctx, PlanReviewEventType.PolicyScopeSetRequested).length > 0
      || readEvents(ctx, PlanReviewEventType.PolicyScopeClearRequested).length > 0;
  },
  access: {
    reads: { components: [Agent, AgentRun, Conversation, Workflow, PlanReviewPolicy, PlanReviewPolicyScopeLink] },
    writes: { components: [PlanReviewPolicy, PlanReviewPolicyScopeLink], mutationMode: 'update' },
    events: { read: [PlanReviewEventType.PolicyScopeSetRequested, PlanReviewEventType.PolicyScopeClearRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, PlanReviewEventType.PolicyScopeSetRequested)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const now = Date.now();
      const existing = findActiveScopeLink(world, payload.scopeKind, scope.scopeId);
      const policyEntity = existing?.link.planReviewPolicy ?? findPlanReviewPolicyById(world, policyIdForScope(payload.scopeKind, scope.scopeId)) ?? cmd.spawn();
      const current = world.get(policyEntity, PlanReviewPolicy);
      cmd.add(policyEntity, PlanReviewPolicy, normalizePlanReviewPolicy({
        ...(current ?? {}),
        id: current?.id ?? policyIdForScope(payload.scopeKind, scope.scopeId),
        mode: payload.mode,
        allowReadonlyBeforeApproval: payload.allowReadonlyBeforeApproval !== false,
        requireForToolRiskLevels: normalizeRequiredRiskLevels(payload.requireForToolRiskLevels),
        updatedAt: now
      }));

      if (existing) {
        cmd.add(existing.entity, PlanReviewPolicyScopeLink, { ...existing.link, planReviewPolicy: policyEntity, updatedAt: now });
        continue;
      }

      const link = cmd.spawn();
      cmd.add(link, PlanReviewPolicyScopeLink, {
        id: linkIdForScope(payload.scopeKind, scope.scopeId),
        scopeKind: payload.scopeKind,
        ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
        planReviewPolicy: policyEntity,
        ...scope.data,
        role: 'active',
        createdAt: now,
        updatedAt: now
      });
    }

    for (const payload of readEvents(ctx, PlanReviewEventType.PolicyScopeClearRequested)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      for (const entity of findActiveScopeLinkEntities(world, payload.scopeKind, scope.scopeId)) cmd.despawn(entity);
    }
  }
});

type ScopeData = Partial<{ conversation: Entity; agent: Entity; workflow: Entity; run: Entity }>;
type ScopeResult = { ok: true; scopeId?: string; data: ScopeData } | { ok: false };

function resolveScope(world: WorldReader, scopeKind: PlanReviewPolicyScopeKind, rawScopeId: string | undefined): ScopeResult {
  const scopeId = rawScopeId?.trim();
  switch (scopeKind) {
    case 'global': return { ok: true, data: {} };
    case 'conversation': {
      if (!scopeId) return { ok: false };
      const conversation = findByRecordId(world, Conversation, scopeId);
      return { ok: true, scopeId, data: conversation !== undefined ? { conversation } : {} };
    }
    case 'agent': {
      if (!scopeId) return { ok: false };
      const agent = findByRecordId(world, Agent, scopeId);
      return { ok: true, scopeId, data: agent !== undefined ? { agent } : {} };
    }
    case 'workflow': {
      if (!scopeId) return { ok: false };
      const workflow = findByRecordId(world, Workflow, scopeId);
      return { ok: true, scopeId, data: workflow !== undefined ? { workflow } : {} };
    }
    case 'run': {
      if (!scopeId) return { ok: false };
      const run = findByRecordId(world, AgentRun, scopeId);
      return { ok: true, scopeId, data: run !== undefined ? { run } : {} };
    }
  }
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: ComponentType<T>, id: string): Entity | undefined {
  return world.query(component).find((entity) => world.get(entity, component)?.id === id);
}

function findPlanReviewPolicyById(world: WorldReader, id: string): Entity | undefined {
  return world.query(PlanReviewPolicy).find((entity) => world.get(entity, PlanReviewPolicy)?.id === id);
}

function findActiveScopeLink(world: WorldReader, scopeKind: PlanReviewPolicyScopeKind, scopeId: string | undefined): { entity: Entity; link: PlanReviewPolicyScopeLinkData } | undefined {
  const entity = findActiveScopeLinkEntities(world, scopeKind, scopeId).at(-1);
  const link = entity === undefined ? undefined : world.get(entity, PlanReviewPolicyScopeLink);
  return entity === undefined || !link ? undefined : { entity, link };
}

function findActiveScopeLinkEntities(world: WorldReader, scopeKind: PlanReviewPolicyScopeKind, scopeId: string | undefined): Entity[] {
  return world.query(PlanReviewPolicyScopeLink).filter((entity) => {
    const link = world.get(entity, PlanReviewPolicyScopeLink);
    return !!link && link.role === 'active' && link.scopeKind === scopeKind && (scopeKind === 'global' ? link.scopeId === undefined : link.scopeId === scopeId);
  });
}

function policyIdForScope(scopeKind: PlanReviewPolicyScopeKind, scopeId: string | undefined): string {
  return scopeKind === 'global'
    ? 'plan-review-policy:global'
    : `plan-review-policy:${scopeKind}:${scopeId ?? 'unknown'}`;
}

function linkIdForScope(scopeKind: PlanReviewPolicyScopeKind, scopeId: string | undefined): string {
  return scopeKind === 'global'
    ? 'plan-review-policy-link:global'
    : `plan-review-policy-link:${scopeKind}:${scopeId ?? 'unknown'}`;
}

function normalizeRequiredRiskLevels(value: unknown): PlanReviewRequiredToolRiskLevel[] {
  if (!Array.isArray(value)) return ['write', 'command', 'agent'];
  const result: PlanReviewRequiredToolRiskLevel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item !== 'write' && item !== 'command' && item !== 'agent') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.length > 0 ? result : ['write', 'command', 'agent'];
}
