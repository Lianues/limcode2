import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentConversationLink } from '../../agent/components';
import {
  AgentModeLink,
  ModeModelProfileLink,
  ModeSystemPromptLink,
  ModeToolPolicyLink,
  ModelProfile,
  type ModelProfileData,
  SystemPrompt,
  type SystemPromptData,
  ToolPolicy,
  type ToolPolicyData
} from '../../mode/components';
import { ToolSchemasKey } from '../../tools/resources';
import { sessionMessages } from '../queries';
import { InFlight, LlmRequest, Message, PartOf } from '../components';
import { textContent } from '../../../../../shared/protocol';
import type { LlmModelSettings } from '../../llm/contracts';

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
  all: [AgentConversationLink],
  read: [
    AgentConversationLink,
    AgentModeLink,
    ModeToolPolicyLink,
    ModeSystemPromptLink,
    ModeModelProfileLink,
    ToolPolicy,
    SystemPrompt,
    ModelProfile
  ],
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

      const agent = activeAgentForConversation(world, data.sessionEntity);
      const mode = agent === undefined ? undefined : activeModeForAgent(world, agent);
      const systemPrompt = mode === undefined ? undefined : activeSystemPromptForMode(world, mode)?.text;
      const modelProfile = mode === undefined ? undefined : activeModelProfileForMode(world, mode);
      const model = modelProfile === undefined
        ? undefined
        : { provider: modelProfile.provider, model: modelProfile.model, temperature: modelProfile.temperature } satisfies LlmModelSettings;
      const toolPolicy = mode === undefined ? undefined : activeToolPolicyForMode(world, mode);
      const allowedTools = toolPolicy?.allowedTools;
      const tools = allowedTools && allowedTools.length > 0
        ? allTools.filter((tool) => allowedTools.includes(tool.name))
        : allTools;

      const contents = [
        ...sessionMessages(world, data.sessionEntity)
        .filter((entity) => entity !== data.modelMessageEntity)
        .map((entity) => world.get(entity, Message))
        .filter((message): message is NonNullable<typeof message> => !!message && message.status !== 'streaming')
        .map((message) => message.content)
      ];

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

function activeAgentForConversation(world: WorldReader, conversation: Entity): Entity | undefined {
  const links = world
    .query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.conversation === conversation);

  return links.find((link) => link.role === 'active')?.agent ?? links[0]?.agent;
}

function activeModeForAgent(world: WorldReader, agent: Entity): Entity | undefined {
  const links = world
    .query(AgentModeLink)
    .map((entity) => world.get(entity, AgentModeLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.agent === agent);

  return links.find((link) => link.role === 'active')?.mode
    ?? links.find((link) => link.role === 'default')?.mode
    ?? links[0]?.mode;
}

function activeToolPolicyForMode(world: WorldReader, mode: Entity): ToolPolicyData | undefined {
  const link = world
    .query(ModeToolPolicyLink)
    .map((entity) => world.get(entity, ModeToolPolicyLink))
    .find((candidate) => candidate?.mode === mode && candidate.role === 'active');
  return link ? world.get(link.toolPolicy, ToolPolicy) : undefined;
}

function activeSystemPromptForMode(world: WorldReader, mode: Entity): SystemPromptData | undefined {
  const link = world
    .query(ModeSystemPromptLink)
    .map((entity) => world.get(entity, ModeSystemPromptLink))
    .find((candidate) => candidate?.mode === mode && candidate.role === 'active');
  return link ? world.get(link.systemPrompt, SystemPrompt) : undefined;
}

function activeModelProfileForMode(world: WorldReader, mode: Entity): ModelProfileData | undefined {
  const link = world
    .query(ModeModelProfileLink)
    .map((entity) => world.get(entity, ModeModelProfileLink))
    .find((candidate) => candidate?.mode === mode && candidate.role === 'active');
  return link ? world.get(link.modelProfile, ModelProfile) : undefined;
}
