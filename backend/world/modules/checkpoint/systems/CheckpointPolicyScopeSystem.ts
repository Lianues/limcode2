import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import type { CheckpointPolicyScopeKind } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Workflow } from '../../workflow/components';
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
    reads: { components: [Agent, AgentRun, Conversation, Workflow, CheckpointPolicy, CheckpointPolicyScopeLink] },
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
  data: Partial<{ conversation: Entity; agent: Entity; workflow: Entity; run: Entity }>;
}

type ScopeResult = ResolvedScope | { ok: false };

function resolveScope(world: WorldReader, scopeKind: CheckpointPolicyScopeKind, rawScopeId: string | undefined): ScopeResult {
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

function defaultPolicyName(scopeKind: CheckpointPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认存档点策略';
    case 'conversation': return '对话存档点策略';
    case 'agent': return 'Agent 存档点策略';
    case 'workflow': return '工作流存档点策略';
    case 'run': return '运行存档点策略';
  }
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
