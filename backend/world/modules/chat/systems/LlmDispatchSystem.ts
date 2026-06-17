import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import {
  AgentModeLink,
  ConversationModeSelection,
  Mode,
  ModeModelProfileLink,
  ModeSystemPromptLink,
  ModeToolPolicyLink,
  ModelProfile,
  SystemPrompt,
  ToolPolicy
} from '../../mode/components';
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
import { ToolCall, ToolPolicyScopeLink, ToolState } from '../../tools/components';
import { ToolSchemasKey } from '../../tools/resources';
import { buildRuntimeToolSchemas, TOOL_SCHEMA_CONTRIBUTOR_READS } from '../../tools/schemaContributors';
import { Conversation, InFlight, LlmRequest, Message, MessageCurrentRevisionLink, PartOf } from '../components';
import { textContent } from '../../../../../shared/protocol';
import { formatWorkEnvironmentContext } from '../../workEnvironment/queries';
import type { LlmModelSettings, LlmStartRequest, ToolSchema } from '../../llm/contracts';
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
  ConversationModeSelection,
  Mode,
  AgentModeLink,
  ModeSystemPromptLink,
  ModeModelProfileLink,
  ModeToolPolicyLink,
  SystemPrompt,
  ModelProfile,
  ToolPolicy,
  ToolPolicyScopeLink,
  ToolCall,
  ToolState,
  ...(TOOL_SCHEMA_CONTRIBUTOR_READS.components ?? [])
] as const;

export interface BuildLlmStartRequestForRunInput {
  run: Entity;
  conversation?: Entity;
  modelMessage?: Entity;
  requestId?: string;
  tools?: ToolSchema[];
}

export const LlmDispatchSystem = defineSystem({
  name: 'LlmDispatchSystem',
  worker: { modulePath: '../world/modules/chat/systems/LlmDispatchSystem', exportName: 'LlmDispatchSystem' },
  shouldRun({ world }) {
    return world.query(LlmRequest).some((request) => !world.has(request, InFlight));
  },
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

      const contextPolicy = activeContextPolicyForRun(world, data.run);
      const contextInput = {
        run: data.run,
        conversation: data.conversation,
        modelMessage: data.modelMessage,
        policy: contextPolicy
      };
      recordInputRevisions(world, cmd, contextInput.run, selectRunContextMessageEntities(world, contextInput));
      const llmRequest = buildLlmStartRequestForRun(world, { run: data.run, conversation: data.conversation, modelMessage: data.modelMessage, requestId: data.id, tools: allTools });
      if (!llmRequest) continue;

      cmd.effect({
        kind: 'llm.start',
        request: llmRequest
      });
      cmd.add(request, InFlight, { kind: 'llm', startedAt: Date.now() });
    }
  }
});

export function buildLlmStartRequestForRun(world: WorldReader, input: BuildLlmStartRequestForRunInput): LlmStartRequest | undefined {
  const context = resolveLlmContext(world, input);
  if (!context) return undefined;

  const systemPrompt = activeSystemPromptForRun(world, input.run)?.text;
  const workEnvironmentContext = formatWorkEnvironmentContext(world, input.run);
  const modelProfile = activeModelProfileForRun(world, input.run);
  const conversation = world.get(context.conversation, Conversation);
  const model = modelProfile === undefined
    ? undefined
    : { provider: modelProfile.provider, model: modelProfile.model } satisfies LlmModelSettings;
  const toolPolicy = activeToolPolicyForRun(world, input.run);
  const allTools = input.tools ?? world.tryGetResource(ToolSchemasKey) ?? [];
  const filteredTools = toolPolicy
    ? allTools.filter((tool) => toolPolicy.allowedTools.includes(tool.name))
    : [];
  const tools = buildRuntimeToolSchemas(filteredTools, { world, run: input.run, conversation: context.conversation });
  const contextPolicy = activeContextPolicyForRun(world, input.run);
  const contents = buildRunContextContents(world, { ...context, policy: contextPolicy });
  const systemText = [systemPrompt, workEnvironmentContext].filter((item): item is string => !!item?.trim()).join('\n\n');

  return {
    id: input.requestId ?? `dryrun-${input.run}-${Date.now()}`,
    systemInstruction: systemText ? textContent('user', systemText) : undefined,
    contents,
    tools,
    conversationId: conversation?.id,
    model
  };
}




function resolveLlmContext(world: WorldReader, input: BuildLlmStartRequestForRunInput): { run: Entity; conversation: Entity; modelMessage: Entity } | undefined {
  const modelMessage = input.modelMessage ?? latestModelMessageForRun(world, input.run);
  if (modelMessage === undefined) return undefined;
  const conversation = input.conversation ?? world.get(modelMessage, PartOf)?.parent;
  if (conversation === undefined) return undefined;
  return { run: input.run, conversation, modelMessage };
}

function latestModelMessageForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world
    .query(MessageRunLink)
    .map((entity) => world.get(entity, MessageRunLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.run === run && link.role === 'model')
    .sort((left, right) => (world.get(right.message, Message)?.seq ?? 0) - (world.get(left.message, Message)?.seq ?? 0))
    [0]?.message;
}

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
