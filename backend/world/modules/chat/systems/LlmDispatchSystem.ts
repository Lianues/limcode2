import { defineQuery, defineSystem } from '../../../../ecs/types';
import { ToolSchemasKey } from '../../tools/resources';
import { sessionMessages } from '../queries';
import type { PromptMessage } from '../../llm/contracts';
import { InFlight, LlmRequest, Message, PartOf } from '../components';

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

export const LlmDispatchSystem = defineSystem({
  name: 'LlmDispatchSystem',
  worker: { modulePath: '../world/modules/chat/systems/LlmDispatchSystem', exportName: 'LlmDispatchSystem' },
  access: {
    queries: [PendingLlmRequestsQuery, SessionMessagesQuery],
    resources: { read: [ToolSchemasKey] },
    effects: { emit: ['llm.start'] }
  },
  run({ world, cmd }) {
    const requests = world.query(LlmRequest).filter((request) => !world.has(request, InFlight));
    if (requests.length === 0) return;

    const tools = world.getResource(ToolSchemasKey);

    for (const request of requests) {
      const data = world.get(request, LlmRequest);
      if (!data) continue;

      const messages: PromptMessage[] = sessionMessages(world, data.sessionEntity)
        .filter((entity) => entity !== data.assistantEntity)
        .map((entity) => world.get(entity, Message))
        .filter((message): message is NonNullable<typeof message> => !!message && message.status !== 'streaming')
        .map((message) => ({ role: message.role, content: message.text }));

      cmd.effect({ kind: 'llm.start', request: { id: data.id, messages, tools } });
      cmd.add(request, InFlight, { kind: 'llm', startedAt: Date.now() });
    }
  }
});
