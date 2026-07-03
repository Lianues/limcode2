import type { Entity, WorldReader } from '../../../ecs/types';
import type {
  CheckpointPolicyRecord,
  CheckpointPolicyScopeKind
} from '../../../../shared/protocol';
import { Agent } from '../agent/components';
import { agentTypeEntityForRuntimeAgent } from '../agent/identity';
import { AgentRun, AgentRunTargetLink } from '../agentRun/components';
import { activeModeForRun, activeModeSelectionForConversation, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { Mode } from '../mode/components';
import { CheckpointPolicy, CheckpointPolicyScopeLink, type CheckpointPolicyScopeLinkData } from './components';
import { DEFAULT_CHECKPOINT_TRIGGERS, normalizeCheckpointPolicy } from './policy';

export interface CheckpointPolicyResolution {
  policy: CheckpointPolicyRecord;
  policyEntity?: Entity;
  link?: CheckpointPolicyScopeLinkData;
  inheritedFrom?: CheckpointPolicyScopeKind | 'fallback';
}

export function effectiveCheckpointPolicyForRequest(
  world: WorldReader,
  input: { conversation: Entity; run?: Entity }
): CheckpointPolicyResolution {
  if (input.run !== undefined) {
    const runLocal = localCheckpointPolicyForScopeEntity(world, 'run', input.run);
    if (runLocal.policy) return runLocal as CheckpointPolicyResolution;
    const mode = activeModeForRun(world, input.run);
    if (mode !== undefined) {
      const modePolicy = localCheckpointPolicyForScopeEntity(world, 'mode', mode);
      if (modePolicy.policy) return { ...modePolicy, inheritedFrom: 'mode' } as CheckpointPolicyResolution;
    }
    const target = runTarget(world, input.run);
    if (target) {
      const conversationPolicy = localCheckpointPolicyForScopeEntity(world, 'conversation', target.conversation);
      if (conversationPolicy.policy) return { ...conversationPolicy, inheritedFrom: 'conversation' } as CheckpointPolicyResolution;
      const agentPolicy = localCheckpointPolicyForScopeEntity(world, 'agent', agentTypeEntityForRuntimeAgent(world, target.agent));
      if (agentPolicy.policy) return { ...agentPolicy, inheritedFrom: 'agent' } as CheckpointPolicyResolution;
    }
  }

  const selectedMode = activeModeSelectionForConversation(world, input.conversation);
  if (selectedMode?.scopeKind === 'mode') {
    const modePolicy = localCheckpointPolicyForScopeEntity(world, 'mode', selectedMode.mode);
    if (modePolicy.policy) return { ...modePolicy, inheritedFrom: 'mode' } as CheckpointPolicyResolution;
  }

  const local = localCheckpointPolicyForScopeEntity(world, 'conversation', input.conversation);
  if (local.policy) return local as CheckpointPolicyResolution;

  const global = localCheckpointPolicyForScope(world, 'global');
  if (global.policy) return { ...global, inheritedFrom: 'global' } as CheckpointPolicyResolution;

  return { policy: fallbackCheckpointPolicy(), inheritedFrom: 'fallback' };
}

export function localCheckpointPolicyForScope(
  world: WorldReader,
  scopeKind: CheckpointPolicyScopeKind,
  scopeId?: string
): Partial<CheckpointPolicyResolution> {
  const normalizedScopeId = scopeKind === 'global' ? undefined : scopeId?.trim();
  const matches = world
    .query(CheckpointPolicyScopeLink)
    .map((entity) => ({ entity, link: world.get(entity, CheckpointPolicyScopeLink) }))
    .filter((item): item is { entity: Entity; link: CheckpointPolicyScopeLinkData } =>
      !!item.link && item.link.role === 'active' && item.link.scopeKind === scopeKind && (scopeKind === 'global' ? item.link.scopeId === undefined : scopeIdForLink(world, item.link) === normalizedScopeId)
    )
    .sort((left, right) => right.link.updatedAt - left.link.updatedAt || right.link.createdAt - left.link.createdAt || right.entity - left.entity);
  const selected = matches[0];
  const policy = selected ? world.get(selected.link.checkpointPolicy, CheckpointPolicy) : undefined;
  return {
    ...(policy ? { policy, policyEntity: selected?.link.checkpointPolicy } : {}),
    ...(selected?.link ? { link: selected.link } : {})
  };
}

export function findRunById(world: WorldReader, runId: string | undefined): Entity | undefined {
  const id = runId?.trim();
  if (!id) return undefined;
  return world.query(AgentRun).find((entity) => world.get(entity, AgentRun)?.id === id);
}

function localCheckpointPolicyForScopeEntity(world: WorldReader, scopeKind: CheckpointPolicyScopeKind, scopeEntity: Entity | undefined): Partial<CheckpointPolicyResolution> {
  if (scopeEntity === undefined) return {};
  return localCheckpointPolicyForScope(world, scopeKind, recordIdForScopeEntity(world, scopeKind, scopeEntity));
}

function scopeIdForLink(world: WorldReader, link: CheckpointPolicyScopeLinkData): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'mode': return link.mode !== undefined ? world.get(link.mode, Mode)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
  }
}

function recordIdForScopeEntity(world: WorldReader, scopeKind: CheckpointPolicyScopeKind, entity: Entity): string | undefined {
  switch (scopeKind) {
    case 'global': return undefined;
    case 'conversation': return world.get(entity, Conversation)?.id;
    case 'agent': return world.get(entity, Agent)?.id;
    case 'mode': return world.get(entity, Mode)?.id;
    case 'run': return world.get(entity, AgentRun)?.id;
  }
}

function fallbackCheckpointPolicy(): CheckpointPolicyRecord {
  return normalizeCheckpointPolicy({
    id: 'checkpoint-policy:global:global',
    name: '全局默认存档点策略',
    enabled: true,
    initialSnapshotMaxBytes: 50 * 1024 * 1024,
    preserveEmptyDirectories: true,
    useGitignore: true,
    skipPatterns: ['node_modules/', 'dist/', 'out/', 'build/'],
    triggers: DEFAULT_CHECKPOINT_TRIGGERS
  });
}
