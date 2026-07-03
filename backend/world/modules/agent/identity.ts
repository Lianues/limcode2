import type { AgentSource } from '../../../../shared/protocol';
import type { Entity, WorldReader } from '../../../ecs/types';
import { Agent, AgentKind } from './components';

export function projectedAgentSource(source: AgentSource): AgentSource {
  return source;
}

export function isTemporaryAgentEntity(world: WorldReader, agent: Entity): boolean {
  const data = world.get(agent, Agent);
  const kind = world.get(agent, AgentKind)?.kind;
  return !!data?.id && !!kind && isRunAgentTemporaryId(data.id, kind);
}

export function agentTypeEntityForRuntimeAgent(world: WorldReader, agent: Entity): Entity {
  const typeId = world.get(agent, AgentKind)?.kind;
  if (!typeId || !isTemporaryAgentEntity(world, agent)) return agent;
  return findAgentTypeEntity(world, typeId) ?? agent;
}

export function findAgentTypeEntity(world: WorldReader, selector: string): Entity | undefined {
  return world.query(Agent).find((entity) => {
    if (isTemporaryAgentEntity(world, entity)) return false;
    return world.get(entity, Agent)?.id === selector || world.get(entity, AgentKind)?.kind === selector;
  });
}

export function isRunAgentTemporaryId(id: string, kind: string): boolean {
  const prefix = `agent-${agentSelectorSlug(kind)}-`;
  return id.startsWith(prefix) && /^[a-z0-9]+-[a-z0-9]{8}$/.test(id.slice(prefix.length));
}

export function agentSelectorSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'default';
}
