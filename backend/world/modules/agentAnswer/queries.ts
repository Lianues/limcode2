import type { Entity, WorldReader } from '../../../ecs/types';
import {
  AgentAnswer,
  AgentAnswerSubmissionLink,
  AgentAnswerTargetLink,
  type AgentAnswerData,
  type AgentAnswerSubmissionLinkData,
  type AgentAnswerTargetLinkData
} from './components';

export function agentAnswerById(world: WorldReader, id: string): Entity | undefined {
  const normalized = id.trim();
  if (!normalized) return undefined;
  return world.query(AgentAnswer).find((entity) => world.get(entity, AgentAnswer)?.id === normalized);
}

export function agentAnswerRecordById(world: WorldReader, id: string): { entity: Entity; data: AgentAnswerData } | undefined {
  const entity = agentAnswerById(world, id);
  const data = entity !== undefined ? world.get(entity, AgentAnswer) : undefined;
  return entity !== undefined && data ? { entity, data } : undefined;
}

export function agentAnswerSubmissionLinkForAnswer(world: WorldReader, answer: Entity): AgentAnswerSubmissionLinkData | undefined {
  return world
    .query(AgentAnswerSubmissionLink)
    .map((entity) => world.get(entity, AgentAnswerSubmissionLink))
    .find((link) => link?.answer === answer);
}

export function agentAnswerTargetLinkForAnswer(world: WorldReader, answer: Entity): AgentAnswerTargetLinkData | undefined {
  return world
    .query(AgentAnswerTargetLink)
    .map((entity) => world.get(entity, AgentAnswerTargetLink))
    .find((link) => link?.answer === answer);
}
