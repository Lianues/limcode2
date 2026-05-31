import type { AgentRunControlPayload } from '../../../../shared/protocol';

export const AgentRunEventType = {
  Cancel: 'agentRun:cancel',
  CancelConversation: 'agentRun:cancelConversation',
  Pause: 'agentRun:pause',
  Resume: 'agentRun:resume',
  Retry: 'agentRun:retry',
  Regenerate: 'agentRun:regenerate',
  MarkStale: 'agentRun:markStale'
} as const;

export type AgentRunControlEventPayload = AgentRunControlPayload;
export interface AgentRunConversationControlEventPayload {
  conversationId: string;
  reason?: string;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'agentRun:cancel': AgentRunControlEventPayload;
    'agentRun:cancelConversation': AgentRunConversationControlEventPayload;
    'agentRun:pause': AgentRunControlEventPayload;
    'agentRun:resume': AgentRunControlEventPayload;
    'agentRun:retry': AgentRunControlEventPayload;
    'agentRun:regenerate': AgentRunControlEventPayload;
    'agentRun:markStale': AgentRunControlEventPayload;
  }
}
