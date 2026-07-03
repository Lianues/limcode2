import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import {
  ConversationModeSelection,
  Mode,
  ModelProfileScopeLink,
  ModelProfile,
  SystemPromptScopeLink,
  SystemPrompt,
  ToolPolicy
} from '../../mode/components';
import { Agent } from '../../agent/components';
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
import { CompressionBlock, CompressionContextVariant, RunCompressionBlockLink } from '../../compression/components';
import { hasActiveBlockingCompression } from '../../compression/queries';
import { ToolCall, ToolPolicyScopeLink, ToolState } from '../../tools/components';
import { ToolDefinitionsKey, ToolSchemasKey } from '../../tools/resources';
import { isToolAllowedByPolicy } from '../../tools/policy';
import { buildRuntimeToolSchemas, TOOL_SCHEMA_CONTRIBUTOR_READS } from '../../tools/schemaContributors';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink
} from '../../runtimeContext/components';
import { PROMPT_CONTEXT_PLACEHOLDER_READS, renderSystemPromptTemplate } from '../../runtimeContext/placeholders';
import { Conversation, InFlight, LlmRequest, Message, MessageCurrentRevisionLink, PartOf, type LlmRequestData } from '../components';
import { textContent } from '../../../../../shared/protocol';
import type { LlmModelSettings, LlmStartRequest, ToolSchema } from '../../llm/contracts';
import { LlmInvocation } from '../../llm/components';
import { CheckpointBarrier, type CheckpointBarrierData } from '../../checkpoint/components';
import { consumeReleasedCheckpointBarrier } from '../../checkpoint/barriers';
import {
  activeContextPolicyForRun,
  activeModelProfileForRun,
  systemPromptsForRun,
  activeToolPolicyForRun
} from '../../agentRun/queries';
import { buildRunContextContents, selectRunContextCompressionVariant, selectRunContextMessageEntities } from '../../agentRun/contextPolicy';
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
  CheckpointBarrier,
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
  Agent,
  SystemPromptScopeLink,
  ModelProfileScopeLink,
  SystemPrompt,
  ModelProfile,
  ToolPolicy,
  ToolPolicyScopeLink,
  ToolCall,
  ToolState,
  LlmInvocation,
  CompressionBlock,
  CompressionContextVariant,
  RunCompressionBlockLink,
  RuntimeContextSnapshot,
  ConversationRuntimeContextSnapshotLink,
  RunRuntimeContextSnapshotLink,
  ...(TOOL_SCHEMA_CONTRIBUTOR_READS.components ?? []),
  ...(PROMPT_CONTEXT_PLACEHOLDER_READS.components ?? [])
] as const;

export interface BuildLlmStartRequestForRunInput {
  run: Entity;
  conversation?: Entity;
  modelMessage?: Entity;
  invocation?: Entity;
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
    writes: { components: [RunCompressionBlockLink, CheckpointBarrier] },
    bundles: [AgentRunBundle],
    resources: { read: [ToolSchemasKey, ToolDefinitionsKey, ...(TOOL_SCHEMA_CONTRIBUTOR_READS.resources ?? [])] },
    effects: { emit: ['llm.start'] }
  },
  run({ world, cmd }) {
    const requests = world.query(LlmRequest).filter((request) => !world.has(request, InFlight));
    if (requests.length === 0) return;

    const allTools = world.getResource(ToolSchemasKey);

    for (const request of requests) {
      const data = world.get(request, LlmRequest);
      if (!data) continue;
      if (hasActiveBlockingCompression(world, data.conversation)) continue;
      const barriers = checkpointBarriersForLlmRequest(world, request, data);
      if (barriers.some((item) => item.barrier.status !== 'released')) continue;
      for (const barrier of barriers) consumeReleasedCheckpointBarrier(cmd, barrier.entity);

      const contextPolicy = activeContextPolicyForRun(world, data.run);
      const contextInput = {
        run: data.run,
        conversation: data.conversation,
        modelMessage: data.modelMessage,
        policy: contextPolicy,
        settingsSnapshot: data.invocation !== undefined ? world.get(data.invocation, LlmInvocation)?.settings : undefined
      };
      recordInputRevisions(world, cmd, contextInput.run, selectRunContextMessageEntities(world, contextInput));
      const llmRequest = buildLlmStartRequestForRun(world, { run: data.run, conversation: data.conversation, modelMessage: data.modelMessage, invocation: data.invocation, requestId: data.id, tools: allTools });
      if (!llmRequest) continue;
      recordCompressionContextLink(world, cmd, data.run, data.conversation, llmRequest.settingsSnapshot);

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

  const systemPrompt = composeSystemInstruction(systemPromptsForRun(world, input.run).map((prompt) => ({
    ...prompt,
    text: renderSystemPromptTemplate(prompt.text, { world, run: input.run, conversation: context.conversation })
  })));
  const invocation = input.invocation !== undefined ? world.get(input.invocation, LlmInvocation) : undefined;
  const settingsSnapshot = invocation?.settings;
  const modelProfile = activeModelProfileForRun(world, input.run);
  const conversation = world.get(context.conversation, Conversation);
  const model = settingsSnapshot?.modelId
    ? { providerConfigId: settingsSnapshot.providerConfigId, provider: settingsSnapshot.provider, model: settingsSnapshot.modelId } satisfies LlmModelSettings
    : modelProfile === undefined
    ? undefined
    : { providerConfigId: modelProfile.providerConfigId, provider: modelProfile.provider, model: modelProfile.model } satisfies LlmModelSettings;
  const toolPolicy = activeToolPolicyForRun(world, input.run);
  const allTools = input.tools ?? world.tryGetResource(ToolSchemasKey) ?? [];
  const definitionsByName = new Map((world.tryGetResource(ToolDefinitionsKey) ?? []).map((tool) => [tool.name, tool]));
  const filteredTools = toolPolicy
    ? allTools.filter((tool) => {
        const definition = definitionsByName.get(tool.name);
        return definition ? isToolAllowedByPolicy(toolPolicy, definition) : toolPolicy.allowedTools.includes(tool.name);
      })
    : [];
  const tools = buildRuntimeToolSchemas(filteredTools, { world, run: input.run, conversation: context.conversation });
  const contextPolicy = activeContextPolicyForRun(world, input.run);
  const contents = buildRunContextContents(world, { ...context, policy: contextPolicy, settingsSnapshot });
  const systemText = systemPrompt.trim();

  return {
    id: input.requestId ?? `dryrun-${input.run}-${Date.now()}`,
    ...(invocation ? { invocationId: invocation.id } : {}),
    systemInstruction: systemText ? textContent('user', systemText) : undefined,
    contents,
    tools,
    conversationId: conversation?.id,
    model,
    ...(settingsSnapshot ? { settingsSnapshot } : {})
  };
}

function checkpointBarriersForLlmRequest(
  world: WorldReader,
  request: Entity,
  data: LlmRequestData
): Array<{ entity: Entity; barrier: CheckpointBarrierData }> {
  const inputMessages = inputMessageEntitiesForRun(world, data.run);
  return world
    .query(CheckpointBarrier)
    .map((entity) => ({ entity, barrier: world.get(entity, CheckpointBarrier) }))
    .filter((item): item is { entity: Entity; barrier: CheckpointBarrierData } => {
      const barrier = item.barrier;
      if (!barrier) return false;
      if (barrier.targetKind === 'llm_request') {
        return barrier.targetLlmRequest === request || barrier.targetLlmRequestId === data.id;
      }
      if (barrier.targetKind === 'message_llm') {
        return barrier.targetMessage !== undefined && inputMessages.has(barrier.targetMessage);
      }
      return false;
    })
    .sort((left, right) => left.barrier.createdAt - right.barrier.createdAt || left.entity - right.entity);
}

function inputMessageEntitiesForRun(world: WorldReader, run: Entity): Set<Entity> {
  const result = new Set<Entity>();
  for (const entity of world.query(MessageRunLink)) {
    const link = world.get(entity, MessageRunLink);
    if (link?.run === run && link.role === 'input') result.add(link.message);
  }
  return result;
}

function composeSystemInstruction(prompts: Array<{ name: string; text: string }>): string {
  return prompts
    .map((prompt) => {
      const text = prompt.text.trim();
      if (!text) return '';
      const name = prompt.name.trim();
      return name ? `[${name}]\n${text}` : text;
    })
    .filter(Boolean)
    .join('\n\n');
}
function recordCompressionContextLink(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  conversation: Entity,
  settingsSnapshot: import('../../../../../shared/protocol').LlmInvocationSettingsSnapshotRecord | undefined
): void {
  const selected = selectRunContextCompressionVariant(world, conversation, settingsSnapshot);
  if (!selected) return;
  const block = world.get(selected.block, CompressionBlock);
  const variant = world.get(selected.variant, CompressionContextVariant);
  if (!block || !variant) return;
  const exists = world.query(RunCompressionBlockLink).some((entity) => {
    const link = world.get(entity, RunCompressionBlockLink);
    return link?.run === run && link.block === selected.block && link.variant === selected.variant;
  });
  if (exists) return;
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, RunCompressionBlockLink, {
    id: `run-compression-${entity}`,
    run,
    block: selected.block,
    variant: selected.variant,
    role: 'context',
    mode: selected.mode,
    createdAt: now,
    updatedAt: now
  });
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
