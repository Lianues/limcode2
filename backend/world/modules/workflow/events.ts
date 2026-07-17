import type { ConversationWorkflowSelectPayload, WorkflowCreatePayload, WorkflowDeletePayload, WorkflowUpdatePayload } from '../../../../shared/protocol';

export const WorkflowEventType = {
  Create: 'workflow:create',
  Update: 'workflow:update',
  Delete: 'workflow:delete',
  ConversationSelect: 'workflow:conversationSelect'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'workflow:create': WorkflowCreatePayload;
    'workflow:update': WorkflowUpdatePayload;
    'workflow:delete': WorkflowDeletePayload;
    'workflow:conversationSelect': ConversationWorkflowSelectPayload;
  }
}
