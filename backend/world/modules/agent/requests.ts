import { defineComponent, type Entity, type World } from '../../../ecs/types';
import { AgentEventType } from './events';

export interface AgentSpawnRequestData {
  kind: string;
  agentId?: string;
  agentName?: string;
  conversationId?: string;
  conversationTitle?: string;
  initialMessage?: string;
}

export const AgentSpawnRequest = defineComponent<AgentSpawnRequestData>('AgentSpawnRequest');

export function requestSpawnAgent(world: World, input: AgentSpawnRequestData): Entity {
  const entity = world.spawn();
  world.add(entity, AgentSpawnRequest, input);
  world.enqueue({ type: AgentEventType.SpawnRequested, payload: { requestEntity: entity } });
  return entity;
}
