import type {
  AgentAnswerRecord,
  AgentAnswerSubmissionLinkRecord,
  AgentAnswerTargetLinkRecord,
  ClientState
} from '../../../../shared/protocol';
import type { AccessDeclaration, Entity, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { ToolCall } from '../tools/components';
import {
  AgentAnswer,
  AgentAnswerSubmissionLink,
  AgentAnswerTargetLink,
  type AgentAnswerSubmissionLinkData,
  type AgentAnswerTargetLinkData
} from './components';

export const agentAnswerStateProjectionReads: AccessDeclaration = {
  components: [AgentAnswer, AgentAnswerSubmissionLink, AgentAnswerTargetLink, Agent, AgentRun, Conversation, ToolCall]
};

export function projectAgentAnswerState(world: WorldReader): Partial<ClientState> {
  return {
    agentAnswers: world.query(AgentAnswer).map((entity): AgentAnswerRecord => ({ ...world.get(entity, AgentAnswer)! })),
    agentAnswerSubmissionLinks: world.query(AgentAnswerSubmissionLink).map((entity) => buildSubmissionLinkRecord(world, entity)).filter(isDefined),
    agentAnswerTargetLinks: world.query(AgentAnswerTargetLink).map((entity) => buildTargetLinkRecord(world, entity)).filter(isDefined)
  };
}

function buildSubmissionLinkRecord(world: WorldReader, entity: Entity): AgentAnswerSubmissionLinkRecord | undefined {
  const link = world.get(entity, AgentAnswerSubmissionLink);
  if (!link) return undefined;
  const answerId = answerRecordId(world, link.answer);
  if (!answerId) return undefined;
  return {
    id: link.id,
    answerId,
    ...submissionIds(world, link),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildTargetLinkRecord(world: WorldReader, entity: Entity): AgentAnswerTargetLinkRecord | undefined {
  const link = world.get(entity, AgentAnswerTargetLink);
  if (!link) return undefined;
  const answerId = answerRecordId(world, link.answer);
  if (!answerId) return undefined;
  return {
    id: link.id,
    answerId,
    ...targetIds(world, link),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function submissionIds(world: WorldReader, link: AgentAnswerSubmissionLinkData): Omit<AgentAnswerSubmissionLinkRecord, 'id' | 'answerId' | 'createdAt' | 'updatedAt'> {
  return {
    ...optionalId('submitterRunId', link.submitterRun !== undefined ? world.get(link.submitterRun, AgentRun)?.id : link.submitterRunId),
    ...optionalId('submitterAgentId', link.submitterAgent !== undefined ? world.get(link.submitterAgent, Agent)?.id : link.submitterAgentId),
    ...optionalId('submitterConversationId', link.submitterConversation !== undefined ? world.get(link.submitterConversation, Conversation)?.id : link.submitterConversationId),
    ...optionalId('submitterToolCallId', link.submitterToolCall !== undefined ? world.get(link.submitterToolCall, ToolCall)?.id : link.submitterToolCallId)
  };
}

function targetIds(world: WorldReader, link: AgentAnswerTargetLinkData): Omit<AgentAnswerTargetLinkRecord, 'id' | 'answerId' | 'createdAt' | 'updatedAt'> {
  return {
    ...optionalId('targetRunId', link.targetRun !== undefined ? world.get(link.targetRun, AgentRun)?.id : link.targetRunId),
    ...optionalId('targetAgentId', link.targetAgent !== undefined ? world.get(link.targetAgent, Agent)?.id : link.targetAgentId),
    ...optionalId('targetConversationId', link.targetConversation !== undefined ? world.get(link.targetConversation, Conversation)?.id : link.targetConversationId),
    ...optionalId('sourceToolCallId', link.sourceToolCall !== undefined ? world.get(link.sourceToolCall, ToolCall)?.id : link.sourceToolCallId)
  };
}

function answerRecordId(world: WorldReader, answer: Entity): string | undefined {
  return world.get(answer, AgentAnswer)?.id;
}

function optionalId<TKey extends string>(key: TKey, value: string | undefined): { [K in TKey]?: string } {
  const id = value?.trim();
  return id ? { [key]: id } as { [K in TKey]?: string } : {};
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
