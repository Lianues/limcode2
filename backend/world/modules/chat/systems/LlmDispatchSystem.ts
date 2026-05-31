import { defineQuery, defineSystem } from '../../../../ecs/types';
import { ToolSchemasKey } from '../../tools/resources';
import { conversationMessages } from '../queries';
import { InFlight, LlmRequest, Message } from '../components';
import { textContent } from '../../../../../shared/protocol';
import type { LlmModelSettings } from '../../llm/contracts';
import {
  activeContextPolicyForRun,
  activeModelProfileForRun,
  activeSystemPromptForRun,
  activeToolPolicyForRun
} from '../../agentRun/queries';

const PendingLlmRequestsQuery = defineQuery({
  name: 'PendingLlmRequests',
  all: [LlmRequest],
  none: [InFlight],
  read: [LlmRequest],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

const MessageLookupQuery = defineQuery({
  name: 'RunConversationMessages',
  all: [Message],
  read: [Message],
  role: 'lookup'
});

export const LlmDispatchSystem = defineSystem({
  name: 'LlmDispatchSystem',
  worker: { modulePath: '../world/modules/chat/systems/LlmDispatchSystem', exportName: 'LlmDispatchSystem' },
  access: {
    queries: [PendingLlmRequestsQuery, MessageLookupQuery],
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

      const systemPrompt = activeSystemPromptForRun(world, data.run)?.text;
      const modelProfile = activeModelProfileForRun(world, data.run);
      const model = modelProfile === undefined
        ? undefined
        : { provider: modelProfile.provider, model: modelProfile.model, temperature: modelProfile.temperature } satisfies LlmModelSettings;
      const toolPolicy = activeToolPolicyForRun(world, data.run);
      const tools = toolPolicy
        ? allTools.filter((tool) => toolPolicy.allowedTools.includes(tool.name))
        : [];

      const contextPolicy = activeContextPolicyForRun(world, data.run);
      const messages = conversationMessages(world, data.conversation)
        .filter((entity) => entity !== data.modelMessage)
        .map((entity) => world.get(entity, Message))
        .filter((message): message is NonNullable<typeof message> => !!message && message.status !== 'streaming');
      const scopedMessages = applyContextPolicy(messages, contextPolicy?.historyMode ?? 'full', contextPolicy?.lastN);
      const contents = scopedMessages.map((message) => message.content);

      cmd.effect({
        kind: 'llm.start',
        request: {
          id: data.id,
          systemInstruction: systemPrompt ? textContent('user', systemPrompt) : undefined,
          contents,
          tools,
          model
        }
      });
      cmd.add(request, InFlight, { kind: 'llm', startedAt: Date.now() });
    }
  }
});

function applyContextPolicy<T>(messages: T[], mode: string, lastN?: number): T[] {
  switch (mode) {
    case 'none':
      return messages.slice(-1);
    case 'last_n':
      return messages.slice(-(lastN ?? 20));
    case 'full':
    default:
      return messages;
  }
}
