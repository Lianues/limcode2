import type { Entity, WorldReader } from '../../../ecs/types';
import type {
  CheckpointPolicyRecord,
  CheckpointPolicyScopeKind,
  CheckpointTriggerKind
} from '../../../../shared/protocol';
import { Agent } from '../agent/components';
import { agentTypeEntityForRuntimeAgent } from '../agent/identity';
import { AgentRun, AgentRunTargetLink } from '../agentRun/components';
import { activeWorkflowForRun, activeWorkflowSelectionForConversation, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { Workflow } from '../workflow/components';
import { CheckpointPolicy, CheckpointPolicyScopeLink, type CheckpointPolicyScopeLinkData } from './components';
import { ToolDefinitionsKey } from '../tools/resources';
import { DEFAULT_CHECKPOINT_TRIGGERS, effectiveCheckpointToolTriggerConfig, normalizeCheckpointPolicy, triggerConfigKey } from './policy';

export interface CheckpointPolicyResolution {
  policy: CheckpointPolicyRecord;
  policyEntity?: Entity;
  link?: CheckpointPolicyScopeLinkData;
  inheritedFrom?: CheckpointPolicyScopeKind | 'fallback';
}

export type CheckpointRequestPolicyEvaluation =
  | { enabled: true; resolution: CheckpointPolicyResolution }
  | { enabled: false; reason: 'policy_disabled' | 'trigger_disabled'; resolution: CheckpointPolicyResolution };

/**
 * 在创建 barrier / Requested 事件前统一判断有效 Checkpoint Policy。
 * RequestSystem 仍会再次调用它作为最终安全校验。
 */
export function evaluateCheckpointRequestPolicy(
  world: WorldReader,
  input: {
    conversation: Entity;
    run?: Entity;
    trigger: CheckpointTriggerKind;
    toolName?: string;
  }
): CheckpointRequestPolicyEvaluation {
  const resolution = effectiveCheckpointPolicyForRequest(world, {
    conversation: input.conversation,
    ...(input.run !== undefined ? { run: input.run } : {})
  });
  if (!resolution.policy.enabled) return { enabled: false, reason: 'policy_disabled', resolution };

  if (input.trigger === 'tool_execution_before' || input.trigger === 'tool_execution_after') {
    const toolName = input.toolName?.trim();
    if (!toolName) return { enabled: false, reason: 'trigger_disabled', resolution };
    const toolDefinition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === toolName);
    const config = effectiveCheckpointToolTriggerConfig(toolName, resolution.policy.toolTriggers, toolDefinition);
    const enabled = input.trigger === 'tool_execution_before' ? config.before : config.after;
    return enabled ? { enabled: true, resolution } : { enabled: false, reason: 'trigger_disabled', resolution };
  }

  const triggerKey = triggerConfigKey(input.trigger);
  return triggerKey && resolution.policy.triggers[triggerKey] === true
    ? { enabled: true, resolution }
    : { enabled: false, reason: 'trigger_disabled', resolution };
}

export function effectiveCheckpointPolicyForRequest(
  world: WorldReader,
  input: { conversation: Entity; run?: Entity }
): CheckpointPolicyResolution {
  if (input.run !== undefined) {
    const runLocal = localCheckpointPolicyForScopeEntity(world, 'run', input.run);
    if (runLocal.policy) return runLocal as CheckpointPolicyResolution;
    const workflow = activeWorkflowForRun(world, input.run);
    if (workflow !== undefined) {
      const workflowPolicy = localCheckpointPolicyForScopeEntity(world, 'workflow', workflow);
      if (workflowPolicy.policy) return { ...workflowPolicy, inheritedFrom: 'workflow' } as CheckpointPolicyResolution;
    }
    const target = runTarget(world, input.run);
    if (target) {
      const conversationPolicy = localCheckpointPolicyForScopeEntity(world, 'conversation', target.conversation);
      if (conversationPolicy.policy) return { ...conversationPolicy, inheritedFrom: 'conversation' } as CheckpointPolicyResolution;
      const agentPolicy = localCheckpointPolicyForScopeEntity(world, 'agent', agentTypeEntityForRuntimeAgent(world, target.agent));
      if (agentPolicy.policy) return { ...agentPolicy, inheritedFrom: 'agent' } as CheckpointPolicyResolution;
    }
  }

  const selectedWorkflow = activeWorkflowSelectionForConversation(world, input.conversation);
  if (selectedWorkflow?.scopeKind === 'workflow') {
    const workflowPolicy = localCheckpointPolicyForScopeEntity(world, 'workflow', selectedWorkflow.workflow);
    if (workflowPolicy.policy) return { ...workflowPolicy, inheritedFrom: 'workflow' } as CheckpointPolicyResolution;
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
    case 'workflow': return link.workflow !== undefined ? world.get(link.workflow, Workflow)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
  }
}

function recordIdForScopeEntity(world: WorldReader, scopeKind: CheckpointPolicyScopeKind, entity: Entity): string | undefined {
  switch (scopeKind) {
    case 'global': return undefined;
    case 'conversation': return world.get(entity, Conversation)?.id;
    case 'agent': return world.get(entity, Agent)?.id;
    case 'workflow': return world.get(entity, Workflow)?.id;
    case 'run': return world.get(entity, AgentRun)?.id;
  }
}

function fallbackCheckpointPolicy(): CheckpointPolicyRecord {
  return normalizeCheckpointPolicy({
    id: 'checkpoint-policy:global:global',
    name: '全局默认存档点策略',
    enabled: false,
    initialSnapshotMaxBytes: 50 * 1024 * 1024,
    preserveEmptyDirectories: true,
    useGitignore: true,
    skipPatterns: ['node_modules/', 'dist/', 'out/', 'build/'],
    triggers: DEFAULT_CHECKPOINT_TRIGGERS
  });
}
