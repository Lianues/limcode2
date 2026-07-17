import type { ComponentType, Entity, WorldReader } from '../../../ecs/types';
import type { SkillPolicyScopeKind } from '../../../../shared/protocol';
import { Agent } from '../agent/components';
import { agentTypeEntityForRuntimeAgent } from '../agent/identity';
import { AgentRun } from '../agentRun/components';
import { runTarget, activeWorkflowForRun } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { Workflow } from '../workflow/components';
import { SkillPolicy, SkillPolicyScopeLink, type SkillPolicyData, type SkillPolicyScopeLinkData } from './components';

/**
 * 解析当前 run 的有效技能策略：最具体作用域优先（run > conversation > workflow > agent），否则回退 global。
 * 与前端 useSkillPolicyStore.effectivePolicyFor 的单策略模型保持一致。
 */
export function activeSkillPolicyForRun(world: WorldReader, run: Entity): SkillPolicyData | undefined {
  const target = runTarget(world, run);
  const workflow = activeWorkflowForRun(world, run);

  return activeSkillPolicyForScopeEntity(world, 'run', run)
    ?? (target ? activeSkillPolicyForScopeEntity(world, 'conversation', target.conversation) : undefined)
    ?? (workflow !== undefined ? activeSkillPolicyForScopeEntity(world, 'workflow', workflow) : undefined)
    ?? (target ? activeSkillPolicyForScopeEntity(world, 'agent', agentTypeEntityForRuntimeAgent(world, target.agent)) : undefined)
    ?? activeSkillPolicyForScopeEntity(world, 'global');
}

export function activeSkillPolicyForScope(world: WorldReader, scopeKind: SkillPolicyScopeKind, scopeId?: string): SkillPolicyData | undefined {
  const scopeEntity = scopeKind === 'global' || scopeKind === 'agentSystem' ? undefined : entityForSkillPolicyScope(world, scopeKind, scopeId);
  return activeSkillPolicyForScopeEntity(world, scopeKind, scopeEntity, scopeId);
}

function activeSkillPolicyForScopeEntity(
  world: WorldReader,
  scopeKind: SkillPolicyScopeKind,
  scopeEntity?: Entity,
  explicitScopeId?: string
): SkillPolicyData | undefined {
  let selected: { entity: Entity; link: SkillPolicyScopeLinkData } | undefined;
  for (const entity of world.query(SkillPolicyScopeLink)) {
    const link = world.get(entity, SkillPolicyScopeLink);
    if (!link || link.role !== 'active' || link.scopeKind !== scopeKind) continue;
    if (!matchesSkillPolicyScope(world, link, scopeKind, scopeEntity, explicitScopeId)) continue;
    if (!selected || isNewerLink(entity, link, selected.entity, selected.link)) selected = { entity, link };
  }
  return selected ? world.get(selected.link.skillPolicy, SkillPolicy) : undefined;
}

function matchesSkillPolicyScope(
  world: WorldReader,
  link: SkillPolicyScopeLinkData,
  scopeKind: SkillPolicyScopeKind,
  scopeEntity?: Entity,
  explicitScopeId?: string
): boolean {
  if (scopeKind === 'global') return true;
  if (scopeKind === 'agentSystem') return !!explicitScopeId && (link.scopeId === explicitScopeId || link.agentSystemId === explicitScopeId);
  if (scopeEntity !== undefined) {
    switch (scopeKind) {
      case 'conversation': return link.conversation === scopeEntity || link.scopeId === world.get(scopeEntity, Conversation)?.id;
      case 'agent': return link.agent === scopeEntity || link.scopeId === world.get(scopeEntity, Agent)?.id;
      case 'workflow': return link.workflow === scopeEntity || link.scopeId === world.get(scopeEntity, Workflow)?.id;
      case 'run': return link.run === scopeEntity || link.scopeId === world.get(scopeEntity, AgentRun)?.id;
    }
  }
  return !!explicitScopeId && link.scopeId === explicitScopeId;
}

function entityForSkillPolicyScope(world: WorldReader, scopeKind: SkillPolicyScopeKind, scopeId: string | undefined): Entity | undefined {
  if (!scopeId) return undefined;
  switch (scopeKind) {
    case 'conversation': return findRecordEntity(world, Conversation, scopeId);
    case 'agent': return findRecordEntity(world, Agent, scopeId);
    case 'workflow': return findRecordEntity(world, Workflow, scopeId);
    case 'run': return findRecordEntity(world, AgentRun, scopeId);
    case 'global':
    case 'agentSystem':
      return undefined;
  }
}

function findRecordEntity<T extends { id: string }>(world: WorldReader, component: ComponentType<T>, id: string): Entity | undefined {
  return world.query(component).find((entity) => world.get(entity, component)?.id === id);
}

function isNewerLink(entity: Entity, link: SkillPolicyScopeLinkData, previousEntity: Entity, previous: SkillPolicyScopeLinkData): boolean {
  const timestamp = link.updatedAt || link.createdAt;
  const previousTimestamp = previous.updatedAt || previous.createdAt;
  return timestamp > previousTimestamp || (timestamp === previousTimestamp && entity > previousEntity);
}
