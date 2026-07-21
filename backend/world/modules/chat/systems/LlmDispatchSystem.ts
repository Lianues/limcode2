import { estimateTokenCount } from 'tokenx';
import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import {
  ConversationWorkflowSelection,
  Workflow,
  ModelProfileScopeLink,
  ModelProfile,
  SystemPromptScopeLink,
  SystemPrompt,
  ToolPolicy
} from '../../workflow/components';
import { Agent } from '../../agent/components';
import {
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunModelProfileLink,
  RunWorkflowLink,
  RunSystemPromptLink,
  RunToolPolicyLink
} from '../../agentRun/components';
import { CompressionBlock, CompressionContextVariant, RunCompressionBlockLink, type CompressionBlockData } from '../../compression/components';
import { CompressionEventType } from '../../compression/events';
import { hasActiveBlockingCompression } from '../../compression/queries';
import { ToolCall, ToolPolicyScopeLink, ToolState } from '../../tools/components';
import { ToolDefinitionsKey, ToolSchemasKey } from '../../tools/resources';
import { isToolNameAllowedByPolicy } from '../../tools/policy';
import { buildRuntimeToolSchemas, TOOL_SCHEMA_CONTRIBUTOR_READS } from '../../tools/schemaContributors';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink
} from '../../runtimeContext/components';
import { compressionThresholdTokens } from '../../llm/usage';
import { PROMPT_CONTEXT_PLACEHOLDER_READS, renderSystemPromptTemplate } from '../../runtimeContext/placeholders';
import { Conversation, InFlight, LlmRequest, LlmRequestPreDispatchCompressionAttempt, Message, MessageCurrentRevisionLink, PartOf, type LlmRequestData } from '../components';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  textContent,
  type ContentPart,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent
} from '../../../../../shared/protocol';
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
import { createStableId } from '../../../../utils/stableId';
import { conversationMessages } from '../queries';

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
  RunWorkflowLink,
  RunSystemPromptLink,
  RunModelProfileLink,
  RunToolPolicyLink,
  ConversationWorkflowSelection,
  Workflow,
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
  LlmRequestPreDispatchCompressionAttempt,
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
  shouldRun({ world }) {
    return world.query(LlmRequest).some((request) => !world.has(request, InFlight));
  },
  access: {
    queries: [PendingLlmRequestsQuery],
    reads: { components: LlmContextLookupComponents },
    writes: { components: [RunCompressionBlockLink, CheckpointBarrier, LlmRequestPreDispatchCompressionAttempt] },
    bundles: [AgentRunBundle],
    resources: { read: [ToolSchemasKey, ToolDefinitionsKey, ...(TOOL_SCHEMA_CONTRIBUTOR_READS.resources ?? [])] },
    events: { emit: [CompressionEventType.Create] },
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
      if (maybeEnqueuePreDispatchCompression(world, cmd, request, data, llmRequest)) continue;
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
    ? allTools.filter((tool) => isToolNameAllowedByPolicy(toolPolicy, tool.name, definitionsByName.get(tool.name)))
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

interface PreDispatchCompressionAnchor {
  entity: Entity;
  id: string;
  seq: number;
  role: string;
}

interface PreDispatchCompressionRisk {
  shouldCompress: boolean;
  estimatedTokens: number;
  thresholdTokens?: number;
  contextWindowTokens?: number;
  currentBoundarySeq: number;
  uncompressedHistoryMessages: number;
  uncompressedRunScopedMessages: number;
  preserveLatestMessages: number;
  reasons: string[];
}

function maybeEnqueuePreDispatchCompression(
  world: WorldReader,
  cmd: CommandSink,
  request: Entity,
  data: LlmRequestData,
  llmRequest: LlmStartRequest
): boolean {
  const settings = llmRequest.settingsSnapshot;
  const methodKind = settings?.compressionMethodKind;
  if (!settings || methodKind === undefined || methodKind === 'disabled' || methodKind === 'manual_summary') return false;
  const conversation = world.get(data.conversation, Conversation);
  const anchor = selectPreDispatchCompressionAnchor(world, data, settings);
  if (!conversation || !anchor) return false;

  const selected = selectRunContextCompressionVariant(world, data.conversation, settings);
  const selectedBlock = selected ? world.get(selected.block, CompressionBlock) : undefined;
  const currentBoundarySeq = selectedBlock?.endSeq ?? selectedBlock?.anchorSeq ?? 0;
  if (anchor.seq <= currentBoundarySeq) return false;

  // 预派发压缩只是一次“尽量缩短上下文”的门禁，不能无限阻塞真正的 LLM 请求。
  // 如果 CompressionSystem 因未闭合工具调用/无增量/流式消息等原因没有生成 CompressionBlock，
  // 下一轮调度会重新回到这里；此时应直接放行主请求，而不是重复 enqueue 同一个 compression.create。
  if (world.has(request, LlmRequestPreDispatchCompressionAttempt)) return false;

  const risk = preDispatchCompressionRisk(world, data, llmRequest, currentBoundarySeq, settings);
  if (!risk.shouldCompress) return false;

  const existingAnchorBlock = latestCompressionBlockForAnchor(world, data.conversation, anchor.id, methodKind);
  if (existingAnchorBlock) return false;

  cmd.add(request, LlmRequestPreDispatchCompressionAttempt, {
    anchorMessageId: anchor.id,
    anchorSeq: anchor.seq,
    methodKind,
    requestedAt: Date.now()
  });
  cmd.enqueue({
    type: CompressionEventType.Create,
    payload: {
      conversationId: conversation.id,
      endMessageId: anchor.id,
      ...(settings.compressionConfigId ? { methodConfigId: settings.compressionConfigId } : {}),
      methodKind,
      trigger: 'auto' as const
    }
  });
  return true;
}

function selectPreDispatchCompressionAnchor(
  world: WorldReader,
  data: LlmRequestData,
  settings: LlmInvocationSettingsSnapshotRecord
): PreDispatchCompressionAnchor | undefined {
  const targetMessages = nonStreamingConversationMessagesBefore(world, data.conversation, data.modelMessage);
  if (targetMessages.length === 0) return undefined;
  const runScopedSet = runScopedMessagesIn(world, data.run, targetMessages);
  const runScopedMessages = targetMessages.filter((entity) => runScopedSet.has(entity));
  const preserveLatestMessages = positiveInteger(settings.compressionTrigger?.preserveLatestMessages) ?? 8;
  const candidates = runScopedMessages.length > 0
    ? targetMessages.filter((entity) => {
      const seq = world.get(entity, Message)?.seq ?? 0;
      const earliestRunScopedSeq = Math.min(...runScopedMessages.map((message) => world.get(message, Message)?.seq ?? Number.POSITIVE_INFINITY));
      return seq < earliestRunScopedSeq;
    })
    : targetMessages.slice(0, Math.max(0, targetMessages.length - preserveLatestMessages));
  if (candidates.length === 0) return undefined;

  const preferred = [...candidates].reverse().find((entity) => isClosedCompressionBoundary(world.get(entity, Message)?.content));
  const anchorEntity = preferred ?? candidates[candidates.length - 1];
  const anchor = world.get(anchorEntity, Message);
  return anchor ? { entity: anchorEntity, id: anchor.id, seq: anchor.seq, role: anchor.role } : undefined;
}

function preDispatchCompressionRisk(
  world: WorldReader,
  data: LlmRequestData,
  llmRequest: LlmStartRequest,
  currentBoundarySeq: number,
  settings: LlmInvocationSettingsSnapshotRecord
): PreDispatchCompressionRisk {
  const targetMessages = nonStreamingConversationMessagesBefore(world, data.conversation, data.modelMessage);
  const runScopedSet = runScopedMessagesIn(world, data.run, targetMessages);
  const uncompressedHistoryMessages = targetMessages.filter((entity) => !runScopedSet.has(entity) && (world.get(entity, Message)?.seq ?? 0) > currentBoundarySeq).length;
  const uncompressedRunScopedMessages = targetMessages.filter((entity) => runScopedSet.has(entity) && (world.get(entity, Message)?.seq ?? 0) > currentBoundarySeq).length;
  const preserveLatestMessages = positiveInteger(settings.compressionTrigger?.preserveLatestMessages) ?? 8;
  const estimatedTokens = estimateLlmRequestTokens(llmRequest);
  const thresholdTokens = compressionThresholdTokens(settings);
  const contextWindowTokens = positiveInteger(settings.contextWindowTokens);
  const triggerAllowsAuto = settings.compressionTrigger?.mode === 'token_threshold';
  const reasons: string[] = [];
  if (triggerAllowsAuto && thresholdTokens !== undefined && estimatedTokens >= thresholdTokens) reasons.push('estimated_tokens_over_threshold');
  if (contextWindowTokens !== undefined && estimatedTokens >= Math.floor(contextWindowTokens * 0.95)) reasons.push('estimated_tokens_near_context_window');

  return {
    shouldCompress: reasons.length > 0,
    estimatedTokens,
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    currentBoundarySeq,
    uncompressedHistoryMessages,
    uncompressedRunScopedMessages,
    preserveLatestMessages,
    reasons
  };
}

function latestCompressionBlockForAnchor(
  world: WorldReader,
  conversation: Entity,
  anchorMessageId: string,
  methodKind: NonNullable<LlmInvocationSettingsSnapshotRecord['compressionMethodKind']>
): { entity: Entity; block: CompressionBlockData } | undefined {
  return world.query(CompressionBlock)
    .map((entity) => ({ entity, block: world.get(entity, CompressionBlock) }))
    .filter((item): item is { entity: Entity; block: CompressionBlockData } => {
      const block = item.block;
      if (!block) return false;
      return block.conversation === conversation
        && block.anchorMessageId === anchorMessageId
        && block.methodKind === methodKind
        && (block.status === 'pending' || block.status === 'running' || block.status === 'complete' || block.status === 'error');
    })
    .sort((left, right) => right.block.createdAt - left.block.createdAt || right.block.id.localeCompare(left.block.id))[0];
}

function nonStreamingConversationMessagesBefore(world: WorldReader, conversation: Entity, modelMessage: Entity): Entity[] {
  const currentModel = world.get(modelMessage, Message);
  return conversationMessages(world, conversation)
    .filter((entity) => entity !== modelMessage)
    .filter((entity) => world.get(entity, Message)?.status !== 'streaming')
    .filter((entity) => currentModel === undefined || (world.get(entity, Message)?.seq ?? 0) < currentModel.seq);
}

function runScopedMessagesIn(world: WorldReader, run: Entity, candidates: Entity[]): Set<Entity> {
  const candidateSet = new Set(candidates);
  const result = new Set<Entity>();
  for (const entity of world.query(MessageRunLink)) {
    const link = world.get(entity, MessageRunLink);
    if (link?.run === run && candidateSet.has(link.message)) result.add(link.message);
  }
  return result;
}

function isClosedCompressionBoundary(content: MessageContent | undefined): boolean {
  if (!content) return false;
  if (content.role === 'model') {
    return content.parts.some((part) => isTextPart(part) && part.thought !== true && part.text.trim())
      && !content.parts.some(isFunctionCallPart);
  }
  return content.role === 'user' && content.parts.some(isFunctionResponsePart);
}

function estimateLlmRequestTokens(request: LlmStartRequest): number {
  const text = [
    ...(request.systemInstruction ? request.systemInstruction.parts.map(renderTokenEstimatePart) : []),
    ...request.contents.flatMap((content) => content.parts.map(renderTokenEstimatePart))
  ].join('\n');
  const estimated = estimateTokenCount(text);
  return Number.isFinite(estimated) ? Math.max(0, estimated) : 0;
}

function renderTokenEstimatePart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${safeJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${safeJson(part.functionResponse.response)}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  return '';
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
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
    id: createStableId('run-compression'),
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
  const existingRevisionIds = new Set<Entity>();
  for (const entity of world.query(AgentRunInputRevision)) {
    const inputRevision = world.get(entity, AgentRunInputRevision);
    if (inputRevision?.run === run) existingRevisionIds.add(inputRevision.revision);
  }

  const currentRevisionByMessage = new Map<Entity, Entity>();
  for (const entity of world.query(MessageCurrentRevisionLink)) {
    const link = world.get(entity, MessageCurrentRevisionLink);
    if (link) currentRevisionByMessage.set(link.message, link.revision);
  }

  for (const message of messages) {
    const revision = currentRevisionByMessage.get(message);
    const conversation = world.get(message, PartOf)?.parent;
    if (revision === undefined || conversation === undefined || existingRevisionIds.has(revision)) continue;
    const entity = cmd.spawn();
    cmd.add(entity, AgentRunInputRevision, { id: createStableId('arir'), run, conversation, revision });
    existingRevisionIds.add(revision);
  }
}
