import { defineComponent, type Entity, type World } from '../../../ecs/types';
import { AgentEventType } from './events';

export interface AgentSpawnRequestData {
  kind: string;
  agentId?: string;
  agentName?: string;
  sessionId?: string;
  parentAgent?: Entity;
  initialTask?: string;
}

export const AgentSpawnRequest = defineComponent<AgentSpawnRequestData>('AgentSpawnRequest');

/**
 * 创建一个 request entity，并通过轻量 event 唤醒调度器。
 * Agent/Session 的真实生成由 AgentSpawnSystem 根据 blueprint 完成。
 */
export function requestSpawnAgent(world: World, input: AgentSpawnRequestData): Entity {
  const entity = world.spawn();
  world.add(entity, AgentSpawnRequest, input);
  world.enqueue({ type: AgentEventType.SpawnRequested, payload: { requestEntity: entity } });
  return entity;
}
