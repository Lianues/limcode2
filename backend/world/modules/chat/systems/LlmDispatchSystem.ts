import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentModeLink, ModeModelProfileLink, ModeSystemPromptLink, ModeToolPolicyLink, ModelProfile, SystemPrompt, ToolPolicy } from '../../mode/components';
import {
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunModelProfileLink,
  RunModeLink,
  RunSystemPromptLink,
  RunToolPolicyLink
} from '../../agentRun/components';
import { ToolCall, ToolState } from '../../tools/components';
import { ToolSchemasKey } from '../../tools/resources';
import { InFlight, LlmRequest, Message, MessageCurrentRevisionLink, PartOf } from '../components';
import { textContent } from '../../../../../shared/protocol';
import type { LlmModelSettings } from '../../llm/contracts';
import {
  activeContextPolicyForRun,
  activeModelProfileForRun,
  activeSystemPromptForRun,
  activeToolPolicyForRun
} from '../../agentRun/queries';
import { buildRunContextContents, selectRunContextMessageEntities } from '../../agentRun/contextPolicy';
import { AgentRunBundle } from '../../agentRun/bundles';

const PendingLlmRequestsQuery = defineQuery({
  name: 'PendingLlmRequests',
  all: [LlmRequest],
  none: [InFlight],
  read: [LlmRequest],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

const LlmContextLookupComponents = [
  Message,
  PartOf,
  MessageRunLink,
  MessageCurrentRevisionLink,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunModeLink,
  RunSystemPromptLink,
  RunModelProfileLink,
  RunToolPolicyLink,
  AgentModeLink,
  ModeSystemPromptLink,
  ModeModelProfileLink,
  ModeToolPolicyLink,
  SystemPrompt,
  ModelProfile,
  ToolPolicy,
  ToolCall,
  ToolState
] as const;

export const LlmDispatchSystem = defineSystem({
  name: 'LlmDispatchSystem',
  worker: { modulePath: '../world/modules/chat/systems/LlmDispatchSystem', exportName: 'LlmDispatchSystem' },
  access: {
    queries: [PendingLlmRequestsQuery],
    reads: { components: LlmContextLookupComponents },
    bundles: [AgentRunBundle],
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
      const contextInput = {
        run: data.run,
        conversation: data.conversation,
        modelMessage: data.modelMessage,
        policy: contextPolicy
      };
      recordInputRevisions(world, cmd, contextInput.run, selectRunContextMessageEntities(world, contextInput));
      const contents = buildRunContextContents(world, contextInput);

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

function recordInputRevisions(world: WorldReader, cmd: CommandSink, run: Entity, messages: Entity[]): void {
  const existingRevisionIds = new Set(
    world
      .query(AgentRunInputRevision)
      .filter((entity) => world.get(entity, AgentRunInputRevision)?.run === run)
      .map((entity) => world.get(entity, AgentRunInputRevision)?.revision)
      .filter((revision): revision is Entity => revision !== undefined)
  );

  for (const message of messages) {
    const revision = currentRevisionForMessage(world, message);
    const conversation = world.get(message, PartOf)?.parent;
    if (revision === undefined || conversation === undefined || existingRevisionIds.has(revision)) continue;
    const entity = cmd.spawn();
    cmd.add(entity, AgentRunInputRevision, { id: `arir${entity}`, run, conversation, revision });
    existingRevisionIds.add(revision);
  }
}

function currentRevisionForMessage(world: WorldReader, message: Entity): Entity | undefined {
  return world
    .query(MessageCurrentRevisionLink)
    .map((entity) => world.get(entity, MessageCurrentRevisionLink))
    .find((link) => link?.message === message)?.revision;
}
