import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import type { CheckpointPolicyScopeKind } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode } from '../../mode/components';
import { CheckpointPolicy, CheckpointPolicyScopeLink } from '../components';
import { CheckpointEventType } from '../events';
import {
  CheckpointBundle,
  checkpointPolicyIdForScope,
  findActiveCheckpointPolicyScopeLink,
  upsertCheckpointPolicy,
  upsertCheckpointPolicyScopeLink
} from '../bundles';
import { DEFAULT_CHECKPOINT_TRIGGERS, mergeCheckpointToolTriggers } from '../policy';

export const CheckpointPolicyScopeSystem = defineSystem({
  name: 'CheckpointPolicyScopeSystem',
  shouldRun(ctx) {
    return readEvents(ctx, CheckpointEventType.PolicyScopeSetRequested).length > 0
      || readEvents(ctx, CheckpointEventType.PolicyScopeClearRequested).length > 0;
  },
  access: {
    reads: { components: [Agent, AgentRun, Conversation, Mode, CheckpointPolicy, CheckpointPolicyScopeLink] },
    bundles: [CheckpointBundle],
    events: { read: [CheckpointEventType.PolicyScopeSetRequested, CheckpointEventType.PolicyScopeClearRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, CheckpointEventType.PolicyScopeSetRequested)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const existing = findActiveCheckpointPolicyScopeLink(world, payload.scopeKind, scope.scopeId);
      const currentPolicy = existing ? world.get(existing.link.checkpointPolicy, CheckpointPolicy) : undefined;
      const policy = upsertCheckpointPolicy(world, cmd, {
        ...(currentPolicy ?? {}),
        id: currentPolicy?.id ?? checkpointPolicyIdForScope(payload.scopeKind, scope.scopeId),
        name: payload.name?.trim() || currentPolicy?.name || defaultPolicyName(payload.scopeKind),
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
        ...(payload.initialSnapshotMaxBytes !== undefined ? { initialSnapshotMaxBytes: payload.initialSnapshotMaxBytes } : {}),
        ...(payload.preserveEmptyDirectories !== undefined ? { preserveEmptyDirectories: payload.preserveEmptyDirectories } : {}),
        ...(payload.useGitignore !== undefined ? { useGitignore: payload.useGitignore } : {}),
        ...(payload.skipPatterns !== undefined ? { skipPatterns: payload.skipPatterns } : {}),
        ...(payload.triggers !== undefined ? { triggers: { ...DEFAULT_CHECKPOINT_TRIGGERS, ...(currentPolicy?.triggers ?? {}), ...payload.triggers } } : {}),
        ...(payload.toolTriggers !== undefined ? { toolTriggers: mergeCheckpointToolTriggers(currentPolicy?.toolTriggers, payload.toolTriggers) } : {})
      });
      upsertCheckpointPolicyScopeLink(world, cmd, { scopeKind: payload.scopeKind, scopeId: scope.scopeId, policy, data: scope.data });
    }

    for (const payload of readEvents(ctx, CheckpointEventType.PolicyScopeClearRequested)) {
      if (payload.scopeKind === 'global') continue;
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const existing = findActiveCheckpointPolicyScopeLink(world, payload.scopeKind, scope.scopeId);
      if (existing) cmd.despawn(existing.entity);
    }
  }
});

interface ResolvedScope {
  ok: true;
  scopeId?: string;
  data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity }>;
}

type ScopeResult = ResolvedScope | { ok: false };

function resolveScope(world: WorldReader, scopeKind: CheckpointPolicyScopeKind, rawScopeId: string | undefined): ScopeResult {
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
  }
}

function defaultPolicyName(scopeKind: CheckpointPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认存档点策略';
    case 'conversation': return '对话存档点策略';
    case 'agent': return 'Agent 存档点策略';
    case 'mode': return '模式存档点策略';
    case 'run': return '运行存档点策略';
  }
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
