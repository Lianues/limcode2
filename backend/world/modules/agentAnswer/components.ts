import { defineComponent, type Entity } from '../../../ecs/types';

export interface AgentAnswerData {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}
export const AgentAnswer = defineComponent<AgentAnswerData>('AgentAnswer');

export interface AgentAnswerSubmissionLinkData {
  id: string;
  answer: Entity;
  submitterRun?: Entity;
  submitterRunId?: string;
  submitterAgent?: Entity;
  submitterAgentId?: string;
  submitterConversation?: Entity;
  submitterConversationId?: string;
  submitterToolCall?: Entity;
  submitterToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}
export const AgentAnswerSubmissionLink = defineComponent<AgentAnswerSubmissionLinkData>('AgentAnswerSubmissionLink');

export interface AgentAnswerTargetLinkData {
  id: string;
  answer: Entity;
  targetRun?: Entity;
  targetRunId?: string;
  targetAgent?: Entity;
  targetAgentId?: string;
  targetConversation?: Entity;
  targetConversationId?: string;
  sourceToolCall?: Entity;
  sourceToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}
export const AgentAnswerTargetLink = defineComponent<AgentAnswerTargetLinkData>('AgentAnswerTargetLink');
