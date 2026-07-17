import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode } from '../../mode/components';
import { WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../components';
import { WorkEnvironmentEventType } from '../events';
import {
  WorkEnvironmentBundle,
  findActivePolicyScopeLink,
  upsertWorkEnvironmentPolicy,
  upsertWorkEnvironmentPolicyScopeLink,
  workEnvironmentPolicyIdForScope
} from '../bundles';
import type { WorkEnvironmentPolicyScopeKind } from '../../../../../shared/protocol';

export const WorkEnvironmentPolicyScopeSystem = defineSystem({
  name: 'WorkEnvironmentPolicyScopeSystem',
  shouldRun(ctx) {
    return readEvents(ctx, WorkEnvironmentEventType.PolicyScopeSetRequested).length > 0
      || readEvents(ctx, WorkEnvironmentEventType.PolicyScopeClearRequested).length > 0;
  },
  access: {
    reads: { components: [Agent, AgentRun, Conversation, Mode, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink] },
    bundles: [WorkEnvironmentBundle],
    events: { read: [WorkEnvironmentEventType.PolicyScopeSetRequested, WorkEnvironmentEventType.PolicyScopeClearRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, WorkEnvironmentEventType.PolicyScopeSetRequested)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const allowedIds = sanitizeAllowedIds(world, payload.allowedWorkEnvironmentIds);
      const defaultId = payload.defaultWorkEnvironmentId && allowedIds.includes(payload.defaultWorkEnvironmentId)
        ? payload.defaultWorkEnvironmentId
        : allowedIds[0];
      const existing = findActivePolicyScopeLink(world, payload.scopeKind, scope.scopeId);
      const currentPolicy = existing ? world.get(existing.link.policy, WorkEnvironmentPolicy) : undefined;
      const policy = upsertWorkEnvironmentPolicy(world, cmd, {
        id: currentPolicy?.id ?? workEnvironmentPolicyIdForScope(payload.scopeKind, scope.scopeId),
        name: payload.name?.trim() || currentPolicy?.name || defaultPolicyName(payload.scopeKind),
        enabled: payload.enabled ?? currentPolicy?.enabled ?? false,
        allowedWorkEnvironmentIds: allowedIds,
        defaultWorkEnvironmentId: defaultId
      });
      upsertWorkEnvironmentPolicyScopeLink(world, cmd, { scopeKind: payload.scopeKind, scopeId: scope.scopeId, policy, data: scope.data });
    }

    for (const payload of readEvents(ctx, WorkEnvironmentEventType.PolicyScopeClearRequested)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const existing = findActivePolicyScopeLink(world, payload.scopeKind, scope.scopeId);
      if (existing) cmd.despawn(existing.entity);
    }
  }
});

interface ResolvedScope {
  ok: true;
  scopeId?: string;
  data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }>;
}

type ScopeResult = ResolvedScope | { ok: false };

function resolveScope(world: WorldReader, scopeKind: WorkEnvironmentPolicyScopeKind, rawScopeId: string | undefined): ScopeResult {
  const scopeId = rawScopeId?.trim();
  switch (scopeKind) {
    case 'global':
      return { ok: true, data: {} };
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
    case 'mode': {
      if (!scopeId) return { ok: false };
      const mode = findByRecordId(world, Mode, scopeId);
      return { ok: true, scopeId, data: mode !== undefined ? { mode } : {} };
    }
    case 'run': {
      if (!scopeId) return { ok: false };
      const run = findByRecordId(world, AgentRun, scopeId);
      return { ok: true, scopeId, data: run !== undefined ? { run } : {} };
    }
    case 'agentSystem':
      return scopeId ? { ok: true, scopeId, data: { agentSystemId: scopeId } } : { ok: false };
  }
}

function sanitizeAllowedIds(world: WorldReader, ids: readonly string[] | undefined): string[] {
  const availableIds = new Set(
    world.query(WorkEnvironment)
      .map((entity) => world.get(entity, WorkEnvironment))
      .filter((item): item is NonNullable<typeof item> => !!item && item.available)
      .map((item) => item.id)
  );
  const result: string[] = [];
  for (const id of ids ?? []) {
    const text = id.trim();
    if (!text || !availableIds.has(text) || result.includes(text)) continue;
    result.push(text);
  }
  return result;
}

function defaultPolicyName(scopeKind: WorkEnvironmentPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认工作环境策略';
    case 'conversation': return '对话工作环境策略';
    case 'agent': return 'Agent 工作环境策略';
    case 'agentSystem': return '多 Agent 系统工作环境策略';
    case 'mode': return '工作流工作环境策略';
    case 'run': return '运行工作环境策略';
  }
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
