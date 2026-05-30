import type { AgentRecord } from '../../shared/protocol';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import { DEFAULT_LLM_MODEL } from '../capabilities';

export const DEFAULT_AGENT_ID = 'main';
export const DEFAULT_SESSION_ID = 'default';
export const DEFAULT_AGENT_NAME = 'LimCode Agent';

export function createDefaultAgentRecord(): AgentRecord {
  return {
    id: DEFAULT_AGENT_ID,
    name: DEFAULT_AGENT_NAME,
    kind: 'main',
    status: 'idle',
    model: { provider: 'deepseek', model: DEFAULT_LLM_MODEL, temperature: 0.2 },
    toolPolicy: { allowedTools: ['read_file', 'shell', 'bash'], approvalMode: 'never' },
    systemPrompt: 'You are LimCode, a concise and helpful AI coding assistant running inside VS Code. Reply in the user\'s language unless asked otherwise.'
  };
}

export function createDefaultAgentSpawnRequest(): AgentSpawnRequestData {
  return {
    kind: 'main',
    agentId: DEFAULT_AGENT_ID,
    agentName: DEFAULT_AGENT_NAME,
    sessionId: DEFAULT_SESSION_ID
  };
}
