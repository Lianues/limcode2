import { defineComponent, Entity } from '../../../ecs/types';
import type { MessageContent, MsgRole, MsgStatus } from '../../../../shared/protocol';

export interface SessionData {
  id: string;
  title?: string;
}
export const Session = defineComponent<SessionData>('Session');
export const NeedsResponse = defineComponent<{ since: number }>('NeedsResponse');
export const Aborted = defineComponent<true>('Aborted');

export interface MessageData {
  id: string;
  role: MsgRole;
  content: MessageContent;
  status: MsgStatus;
  seq: number;
  createdAt: number;
}
export const Message = defineComponent<MessageData>('Message');
export const PartOf = defineComponent<{ parent: Entity }>('PartOf');
export const Streaming = defineComponent<true>('Streaming');

export interface LlmRequestData {
  id: string;
  sessionEntity: Entity;
  modelMessageEntity: Entity;
}
export const LlmRequest = defineComponent<LlmRequestData>('LlmRequest');

export interface InFlightData {
  kind: 'llm' | 'tool';
  startedAt: number;
}
export const InFlight = defineComponent<InFlightData>('InFlight');
