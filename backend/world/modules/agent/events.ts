import type {
  AgentCreatePayload,
  AgentDeletePayload,
  AgentUpdatePayload,
  ConversationAgentSelectPayload,
  ModelProfileScopeClearPayload,
  ModelProfileScopeSetPayload,
  SystemPromptScopeClearPayload,
  SystemPromptScopeSetPayload
} from '../../../../shared/protocol';

export const AgentEventType = {
  SpawnRequested: 'agent:spawnRequested',
  Create: 'agent:create',
  Update: 'agent:update',
  Delete: 'agent:delete',
  ConversationSelect: 'agent:conversationSelect',
  SystemPromptScopeSet: 'agent:systemPromptScopeSet',
  SystemPromptScopeClear: 'agent:systemPromptScopeClear',
  ModelProfileScopeSet: 'agent:modelProfileScopeSet',
  ModelProfileScopeClear: 'agent:modelProfileScopeClear'
} as const;

export interface AgentSpawnRequestedPayload {
  requestEntity: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'agent:spawnRequested': AgentSpawnRequestedPayload;
    'agent:create': AgentCreatePayload;
    'agent:update': AgentUpdatePayload;
    'agent:delete': AgentDeletePayload;
    'agent:conversationSelect': ConversationAgentSelectPayload;
    'agent:systemPromptScopeSet': SystemPromptScopeSetPayload;
    'agent:systemPromptScopeClear': SystemPromptScopeClearPayload;
    'agent:modelProfileScopeSet': ModelProfileScopeSetPayload;
    'agent:modelProfileScopeClear': ModelProfileScopeClearPayload;
  }
}
