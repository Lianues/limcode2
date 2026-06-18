import type { AgentRecord } from '../../shared/protocol';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';

export const DEFAULT_AGENT_ID = 'main';
export const DEFAULT_CONVERSATION_ID = 'default';
export const DEFAULT_AGENT_NAME = 'LimCode Agent';

export function createDefaultAgentRecord(): AgentRecord {
  return {
    id: DEFAULT_AGENT_ID,
    name: DEFAULT_AGENT_NAME,
    kind: 'main',
    source: 'builtin',
    status: 'idle'
  };
}

export function createDefaultAgentSpawnRequest(): AgentSpawnRequestData {
  return {
    kind: 'main',
    agentId: DEFAULT_AGENT_ID,
    agentName: DEFAULT_AGENT_NAME,
    conversationId: DEFAULT_CONVERSATION_ID
  };
}
