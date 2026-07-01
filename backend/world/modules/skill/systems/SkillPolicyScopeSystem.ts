import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode } from '../../mode/components';
import { SkillPolicy, SkillPolicyScopeLink, type SkillPolicyScopeLinkData } from '../components';
import { SkillEventType } from '../events';
import { SkillCatalogKey } from '../resources';
import type { SkillPolicyScopeKind, SkillPolicySourceConfigRecord, SkillSource } from '../../../../../shared/protocol';

const SKILL_SOURCES: readonly SkillSource[] = ['local', 'global'];

export const SkillPolicyScopeSystem = defineSystem({
  name: 'SkillPolicyScopeSystem',
  shouldRun(ctx) {
    return readEvents(ctx, SkillEventType.PolicyScopeSetRequested).length > 0
      || readEvents(ctx, SkillEventType.PolicyScopeClearRequested).length > 0;
  },
  access: {
    reads: { components: [Agent, AgentRun, Conversation, Mode, SkillPolicy, SkillPolicyScopeLink] },
    writes: { components: [SkillPolicy, SkillPolicyScopeLink], mutationMode: 'update' },
    resources: { read: [SkillCatalogKey] },
    events: { read: [SkillEventType.PolicyScopeSetRequested, SkillEventType.PolicyScopeClearRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, SkillEventType.PolicyScopeSetRequested)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const existing = findActiveScopeLink(world, payload.scopeKind, scope.scopeId);
      const now = Date.now();
      const policyName = payload.name?.trim() || defaultPolicyName(payload.scopeKind);
      const nextSourceConfigs = payload.sourceConfigs !== undefined ? sanitizeSourceConfigs(world, payload.sourceConfigs) : undefined;

      if (existing) {
        const currentPolicy = world.get(existing.link.skillPolicy, SkillPolicy);
        if (currentPolicy) {
          cmd.add(existing.link.skillPolicy, SkillPolicy, {
            ...currentPolicy,
            name: policyName,
            ...(nextSourceConfigs !== undefined ? { sourceConfigs: nextSourceConfigs } : {})
          });
          cmd.add(existing.entity, SkillPolicyScopeLink, { ...existing.link, updatedAt: now });
        }
        continue;
      }

      const policy = findSkillPolicyById(world, policyIdForScope(payload.scopeKind, scope.scopeId)) ?? cmd.spawn();
      cmd.add(policy, SkillPolicy, {
        id: policyIdForScope(payload.scopeKind, scope.scopeId),
        name: policyName,
        ...(nextSourceConfigs !== undefined && Object.keys(nextSourceConfigs).length > 0 ? { sourceConfigs: nextSourceConfigs } : {})
      });

      const link = cmd.spawn();
      cmd.add(link, SkillPolicyScopeLink, {
        id: linkIdForScope(payload.scopeKind, scope.scopeId),
        scopeKind: payload.scopeKind,
        ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
        skillPolicy: policy,
        ...scope.data,
        role: 'active',
        createdAt: now,
        updatedAt: now
      });
    }

    for (const payload of readEvents(ctx, SkillEventType.PolicyScopeClearRequested)) {
      if (payload.scopeKind === 'global') continue;
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      for (const entity of findActiveScopeLinkEntities(world, payload.scopeKind, scope.scopeId)) {
        cmd.despawn(entity);
      }
    }
  }
});

interface ResolvedSkillPolicyScope {
  ok: true;
  scopeId?: string;
  data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }>;
}

type ScopeResult = ResolvedSkillPolicyScope | { ok: false };

function sanitizeSourceConfigs(
  world: WorldReader,
  rawConfigs: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> | undefined
): Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> {
  const validSkillIds = new Set((world.tryGetResource(SkillCatalogKey) ?? []).map((skill) => skill.id));
  const result: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> = {};
  for (const source of SKILL_SOURCES) {
    const rawConfig = rawConfigs?.[source];
    if (!rawConfig) continue;
    const disabledSkills = [...new Set(rawConfig.disabledSkills ?? [])]
      .map((id) => id.trim())
      .filter((id) => validSkillIds.has(id));
    result[source] = {
      enabled: rawConfig.enabled !== false,
      ...(disabledSkills.length > 0 ? { disabledSkills } : {})
    };
  }
  return result;
}

function resolveScope(world: WorldReader, scopeKind: SkillPolicyScopeKind, rawScopeId: string | undefined): ScopeResult {
  const scopeId = rawScopeId?.trim();
  switch (scopeKind) {
    case 'global':
      return { ok: true, data: {} };
    case 'conversation': {
      const conversation = scopeId ? findByRecordId(world, Conversation, scopeId) : undefined;
      return conversation === undefined ? { ok: false } : { ok: true, scopeId, data: { conversation } };
    }
    case 'agent': {
      const agent = scopeId ? findByRecordId(world, Agent, scopeId) : undefined;
      return agent === undefined ? { ok: false } : { ok: true, scopeId, data: { agent } };
    }
    case 'mode': {
      const mode = scopeId ? findByRecordId(world, Mode, scopeId) : undefined;
      return mode === undefined ? { ok: false } : { ok: true, scopeId, data: { mode } };
    }
    case 'run': {
      const run = scopeId ? findByRecordId(world, AgentRun, scopeId) : undefined;
      return run === undefined ? { ok: false } : { ok: true, scopeId, data: { run } };
    }
    case 'agentSystem':
      return scopeId ? { ok: true, scopeId, data: { agentSystemId: scopeId } } : { ok: false };
  }
}

function findActiveScopeLink(world: WorldReader, scopeKind: SkillPolicyScopeKind, scopeId: string | undefined): { entity: Entity; link: SkillPolicyScopeLinkData } | undefined {
  const entities = findActiveScopeLinkEntities(world, scopeKind, scopeId);
  const entity = entities[entities.length - 1];
  const link = entity === undefined ? undefined : world.get(entity, SkillPolicyScopeLink);
  return entity === undefined || !link ? undefined : { entity, link };
}

function findActiveScopeLinkEntities(world: WorldReader, scopeKind: SkillPolicyScopeKind, scopeId: string | undefined): Entity[] {
  return world
    .query(SkillPolicyScopeLink)
    .filter((entity) => {
      const link = world.get(entity, SkillPolicyScopeLink);
      return !!link && link.role === 'active' && link.scopeKind === scopeKind && scopeIdForLink(world, link) === normalizedScopeId(scopeKind, scopeId);
    })
    .sort((left, right) => {
      const leftLink = world.get(left, SkillPolicyScopeLink)!;
      const rightLink = world.get(right, SkillPolicyScopeLink)!;
      return (leftLink.updatedAt || leftLink.createdAt) - (rightLink.updatedAt || rightLink.createdAt) || left - right;
    });
}

function scopeIdForLink(world: WorldReader, link: SkillPolicyScopeLinkData): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'mode': return link.mode !== undefined ? world.get(link.mode, Mode)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
    case 'agentSystem': return link.agentSystemId;
  }
}

function normalizedScopeId(scopeKind: SkillPolicyScopeKind, scopeId: string | undefined): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId;
}

function policyIdForScope(scopeKind: SkillPolicyScopeKind, scopeId: string | undefined): string {
  return `skill-policy:${scopeKind}:${scopeId ?? 'global'}`;
}

function linkIdForScope(scopeKind: SkillPolicyScopeKind, scopeId: string | undefined): string {
  return `skill-policy-scope:${scopeKind}:${scopeId ?? 'global'}`;
}

function defaultPolicyName(scopeKind: SkillPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认技能策略';
    case 'conversation': return '对话技能策略';
    case 'agent': return 'Agent 技能策略';
    case 'agentSystem': return '多 Agent 系统技能策略';
    case 'mode': return '模式技能策略';
    case 'run': return '运行技能策略';
  }
}

function findSkillPolicyById(world: WorldReader, id: string): Entity | undefined {
  return findByRecordId(world, SkillPolicy, id);
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
