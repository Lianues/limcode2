import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  AgentRunSourceKind,
  ConversationBranchKind,
  ConversationOriginKind,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageRevisionReason,
  MessageStopReason,
  MsgRole,
  MsgStatus
} from '../../../../shared/protocol';

export interface ConversationData {
  id: string;
  title?: string;
  visibility?: 'visible' | 'hidden' | 'collapsed';
}
export const Conversation = defineComponent<ConversationData>('Conversation');

export interface ConversationReuseLinkData {
  id: string;
  key: string;
  conversation: Entity;
  agent?: Entity;
  createdAt: number;
  updatedAt: number;
}
export const ConversationReuseLink = defineComponent<ConversationReuseLinkData>('ConversationReuseLink');

export interface ConversationBranchLinkData {
  id: string;
  sourceConversation: Entity;
  targetConversation: Entity;
  sourceRevision?: Entity;
  kind: ConversationBranchKind;
  createdAt: number;
  updatedAt: number;
}
export const ConversationBranchLink = defineComponent<ConversationBranchLinkData>('ConversationBranchLink');

export interface ConversationOriginLinkData {
  id: string;
  conversation: Entity;
  originKind: ConversationOriginKind;
  sourceKind?: AgentRunSourceKind;
  sourceAgent?: Entity;
  sourceAgentId?: string;
  sourceConversation?: Entity;
  sourceConversationId?: string;
  sourceMessage?: Entity;
  sourceMessageId?: string;
  sourceToolCall?: Entity;
  sourceToolCallId?: string;
  sourceRun?: Entity;
  sourceRunId?: string;
  createdAt: number;
  updatedAt: number;
}
export const ConversationOriginLink = defineComponent<ConversationOriginLinkData>('ConversationOriginLink');

export const Aborted = defineComponent<true>('Aborted');

export interface MessageData {
  id: string;
  role: MsgRole;
  model?: string;
  content: MessageContent;
  status: MsgStatus;
  seq: number;
  createdAt: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  stopReason?: MessageStopReason;
}
export const Message = defineComponent<MessageData>('Message');
export const PartOf = defineComponent<{ parent: Entity }>('PartOf');
export const Streaming = defineComponent<true>('Streaming');

export interface MessageRevisionData {
  id: string;
  content: MessageContent;
  createdAt: number;
  reason: MessageRevisionReason;
}
export const MessageRevision = defineComponent<MessageRevisionData>('MessageRevision');
export const MessageCurrentRevisionLink = defineComponent<{ id: string; message: Entity; revision: Entity }>('MessageCurrentRevisionLink');

export interface LlmRequestData {
  id: string;
  run: Entity;
  conversation: Entity;
  modelMessage: Entity;
}
export const LlmRequest = defineComponent<LlmRequestData>('LlmRequest');

export interface InFlightData {
  kind: 'llm' | 'tool';
  startedAt: number;
}
export const InFlight = defineComponent<InFlightData>('InFlight');
