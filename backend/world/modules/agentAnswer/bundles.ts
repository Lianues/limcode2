import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { createMessageId } from '../../../../shared/protocol';
import {
  AgentAnswer,
  AgentAnswerSubmissionLink,
  AgentAnswerTargetLink,
  type AgentAnswerData,
  type AgentAnswerSubmissionLinkData,
  type AgentAnswerTargetLinkData
} from './components';

export const AgentAnswerBundle = defineBundle({
  name: 'AgentAnswerBundle',
  writes: [AgentAnswer, AgentAnswerSubmissionLink, AgentAnswerTargetLink],
  mutationMode: 'create',
  spawns: true
});

export interface SpawnAgentAnswerInput {
  id?: string;
  title: string;
  content: string;
  submission?: Omit<AgentAnswerSubmissionLinkData, 'id' | 'answer' | 'createdAt' | 'updatedAt'>;
  target?: Omit<AgentAnswerTargetLinkData, 'id' | 'answer' | 'createdAt' | 'updatedAt'>;
}

export interface SpawnAgentAnswerResult {
  answer: Entity;
  submissionLink: Entity;
  targetLink: Entity;
  id: string;
}

export function spawnAgentAnswer(cmd: CommandSink, input: SpawnAgentAnswerInput): SpawnAgentAnswerResult {
  const answer = cmd.spawn();
  const now = Date.now();
  const id = input.id?.trim() || `agent-answer:${createMessageId()}`;
  const record: AgentAnswerData = {
    id,
    title: input.title,
    content: input.content,
    createdAt: now,
    updatedAt: now
  };
  cmd.add(answer, AgentAnswer, record);

  const submissionLink = cmd.spawn();
  cmd.add(submissionLink, AgentAnswerSubmissionLink, {
    id: `agent-answer-submission:${id}`,
    answer,
    ...(input.submission ?? {}),
    createdAt: now,
    updatedAt: now
  });

  const targetLink = cmd.spawn();
  cmd.add(targetLink, AgentAnswerTargetLink, {
    id: `agent-answer-target:${id}`,
    answer,
    ...(input.target ?? {}),
    createdAt: now,
    updatedAt: now
  });

  return { answer, submissionLink, targetLink, id };
}
