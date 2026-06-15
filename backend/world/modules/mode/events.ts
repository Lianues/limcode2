import type { ConversationModeSelectPayload, ModeCreatePayload, ModeDeletePayload, ModeUpdatePayload } from '../../../../shared/protocol';

export const ModeEventType = {
  Create: 'mode:create',
  Update: 'mode:update',
  Delete: 'mode:delete',
  ConversationSelect: 'mode:conversationSelect'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'mode:create': ModeCreatePayload;
    'mode:update': ModeUpdatePayload;
    'mode:delete': ModeDeletePayload;
    'mode:conversationSelect': ConversationModeSelectPayload;
  }
}
