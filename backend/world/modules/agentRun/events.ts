import type { AgentRunControlPayload, AgentRunQueueHoldReason, QueueInputUpdatePayload } from '../../../../shared/protocol';

export const AgentRunEventType = {
  Cancel: 'agentRun:cancel',
  CancelConversation: 'agentRun:cancelConversation',
  Pause: 'agentRun:pause',
  Resume: 'agentRun:resume',
  Retry: 'agentRun:retry',
  Regenerate: 'agentRun:regenerate',
  MarkStale: 'agentRun:markStale',
  Promote: 'agentRun:promote',
  RemoveQueued: 'agentRun:removeQueued',
  ReorderQueue: 'agentRun:reorderQueue',
  PauseQueue: 'agentRun:pauseQueue',
  ResumeQueue: 'agentRun:resumeQueue',
  ResumeQueueConversation: 'agentRun:resumeQueueConversation',
  UpdateQueuedInput: 'agentRun:updateQueuedInput'
} as const;

export type AgentRunControlEventPayload = AgentRunControlPayload;
export interface AgentRunConversationControlEventPayload {
  conversationId: string;
  reason?: string;
}
export interface AgentRunPromoteEventPayload {
  runId: string;
  conversationId: string;
}
export interface AgentRunRemoveQueuedEventPayload {
  runId: string;
  conversationId: string;
}
export interface AgentRunQueueReorderEventPayload {
  conversationId: string;
  runIds: string[];
}
export interface AgentRunQueueHoldControlEventPayload {
  conversationId: string;
  runId: string;
  reason?: AgentRunQueueHoldReason;
}
export interface AgentRunQueueConversationControlEventPayload {
  conversationId: string;
}
export type AgentRunQueuedInputUpdateEventPayload = QueueInputUpdatePayload;



declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'agentRun:cancel': AgentRunControlEventPayload;
    'agentRun:cancelConversation': AgentRunConversationControlEventPayload;
    'agentRun:pause': AgentRunControlEventPayload;
    'agentRun:resume': AgentRunControlEventPayload;
    'agentRun:retry': AgentRunControlEventPayload;
    'agentRun:regenerate': AgentRunControlEventPayload;
    'agentRun:markStale': AgentRunControlEventPayload;
    'agentRun:promote': AgentRunPromoteEventPayload;
    'agentRun:removeQueued': AgentRunRemoveQueuedEventPayload;
    'agentRun:reorderQueue': AgentRunQueueReorderEventPayload;
    'agentRun:pauseQueue': AgentRunQueueHoldControlEventPayload;
    'agentRun:resumeQueue': AgentRunQueueHoldControlEventPayload;
    'agentRun:resumeQueueConversation': AgentRunQueueConversationControlEventPayload;
    'agentRun:updateQueuedInput': AgentRunQueuedInputUpdateEventPayload;
  }
}
