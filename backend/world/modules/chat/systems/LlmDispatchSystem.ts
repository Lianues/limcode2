import { defineQuery, defineSystem } from '../../../../ecs/types';
import { ModelProfile, OwnedByAgent, SystemPrompt, ToolPolicy } from '../../agent/components';
import { ToolSchemasKey } from '../../tools/resources';
import { sessionMessages } from '../queries';
import type { PromptMessage } from '../../llm/contracts';
import { InFlight, LlmRequest, Message, PartOf, Session } from '../components';

const PendingLlmRequestsQuery = defineQuery({
  name: 'PendingLlmRequests',
  all: [LlmRequest],
  none: [InFlight],
  read: [LlmRequest],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

const SessionMessagesQuery = defineQuery({
  name: 'SessionMessages',
  all: [Message, PartOf],
  read: [Message, PartOf],
  role: 'lookup'
});

const AgentContextQuery = defineQuery({
  name: 'AgentContext',
  all: [Session, OwnedByAgent],
  read: [Session, OwnedByAgent, SystemPrompt, ModelProfile, ToolPolicy],
  role: 'lookup'
});

export const LlmDispatchSystem = defineSystem({
  name: 'LlmDispatchSystem',
  worker: { modulePath: '../world/modules/chat/systems/LlmDispatchSystem', exportName: 'LlmDispatchSystem' },
  access: {
    queries: [PendingLlmRequestsQuery, SessionMessagesQuery, AgentContextQuery],
    resources: { read: [ToolSchemasKey] },
    effects: { emit: ['llm.start'] }
  },
  run({ world, cmd }) {
    const requests = world.query(LlmRequest).filter((request) => !world.has(request, InFlight));
    if (requests.length === 0) return;

    const allTools = world.getResource(ToolSchemasKey);

    for (const request of requests) {
      const data = world.get(request, LlmRequest);
      if (!data) continue;

      const agent = world.get(data.sessionEntity, OwnedByAgent)?.agent;
      const systemPrompt = agent === undefined ? undefined : world.get(agent, SystemPrompt)?.text;
      const model = agent === undefined ? undefined : world.get(agent, ModelProfile);
      const toolPolicy = agent === undefined ? undefined : world.get(agent, ToolPolicy);
      const allowedTools = toolPolicy?.allowedTools;
      const tools = allowedTools && allowedTools.length > 0
        ? allTools.filter((tool) => allowedTools.includes(tool.name))
        : allTools;

      const messages: PromptMessage[] = [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...sessionMessages(world, data.sessionEntity)
        .filter((entity) => entity !== data.assistantEntity)
        .map((entity) => world.get(entity, Message))
        .filter((message): message is NonNullable<typeof message> => !!message && message.status !== 'streaming')
        .map((message) => ({ role: message.role, content: message.text }))
      ];

      cmd.effect({ kind: 'llm.start', request: { id: data.id, messages, tools, model } });
      cmd.add(request, InFlight, { kind: 'llm', startedAt: Date.now() });
    }
  }
});
