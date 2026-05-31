import { defineComponent, type Entity } from '../../../ecs/types';
import type { LlmUsageMetadataRecord, MessageContent, MessageRevisionReason, MsgRole, MsgStatus } from '../../../../shared/protocol';

export interface ConversationData {
  id: string;
  title?: string;
  visibility?: 'visible' | 'hidden' | 'collapsed';
}
export const Conversation = defineComponent<ConversationData>('Conversation');

export const Aborted = defineComponent<true>('Aborted');

export interface MessageData {
  id: string;
  role: MsgRole;
  content: MessageContent;
  status: MsgStatus;
  seq: number;
  createdAt: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
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
