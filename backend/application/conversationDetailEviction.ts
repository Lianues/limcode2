import type { ComponentType, Entity, World } from '../ecs/types';
import {
  ConversationBranchLink,
  ConversationFullContextPending,
  ConversationOriginLink,
  InFlight,
  LlmRequest,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf,
  Streaming
} from '../world/modules/chat/components';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunQueueHold,
  AgentRunQueueOrder,
  AgentRunQueuedInput,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunWorkflowLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../world/modules/agentRun/components';
import { AgentAnswerSubmissionLink, AgentAnswerTargetLink } from '../world/modules/agentAnswer/components';
import {
  Checkpoint,
  CheckpointBarrier,
  CheckpointPolicyScopeLink,
  CheckpointTimelineAnchor
} from '../world/modules/checkpoint/components';
import {
  CompressionBlock,
  CompressionBlockLlmInvocationLink,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  RunCompressionBlockLink
} from '../world/modules/compression/components';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from '../world/modules/llm/components';
import { ModelProfileScopeLink, SystemPromptScopeLink } from '../world/modules/workflow/components';
import { RuntimeContextScopeLink, RunRuntimeContextSnapshotLink } from '../world/modules/runtimeContext/components';
import { SkillPolicyScopeLink } from '../world/modules/skill/components';
import { ToolCall, ToolCallEvent, ToolPolicyScopeLink, ToolState } from '../world/modules/tools/components';
import { isTerminalToolStatus } from '../world/modules/tools/state';
import { RunWorkEnvironmentLink, WorkEnvironmentPolicyScopeLink } from '../world/modules/workEnvironment/components';
import type { AgentRunStatus } from '../../shared/protocol';

interface ConversationDetailGraph {
  readonly conversation: Entity;
  readonly messages: Set<Entity>;
  readonly revisions: Set<Entity>;
  readonly toolCalls: Set<Entity>;
  readonly runs: Set<Entity>;
  readonly compressionBlocks: Set<Entity>;
}

export interface ConversationDetailEvictionResult {
  readonly removedEntities: number;
}

/**
 * 返回 undefined 表示当前 conversation detail 可以安全冷卸载。
 * 判断故意偏保守：跨 conversation 的历史 Run 仍直接持有详情实体时先不卸载，避免制造悬空关系。
 */
export function conversationDetailEvictionBlocker(world: World, conversation: Entity): string | undefined {
  const graph = buildConversationDetailGraph(world, conversation);

  if (world.has(conversation, ConversationFullContextPending)) return 'context_loading';
  if ([...graph.messages].some((entity) =>
    world.get(entity, Message)?.status === 'streaming' || world.has(entity, Streaming) || world.has(entity, InFlight)
  )) return 'message_streaming';

  for (const run of graph.runs) {
    const record = world.get(run, AgentRun);
    if (record && isActiveAgentRunStatus(record.status)) return 'agent_run_active';
  }

  for (const entity of world.query(AgentRunSourceLink)) {
    const link = world.get(entity, AgentRunSourceLink);
    if (!link || !sourceLinkTouchesGraph(link, graph)) continue;
    const run = world.get(link.run, AgentRun);
    if (run && isActiveAgentRunStatus(run.status)) return 'related_agent_run_active';
    if (!graph.runs.has(link.run) && sourceLinkTouchesEvictableDetail(link, graph)) return 'external_run_source_reference';
  }

  for (const entity of world.query(AgentRunTargetLink)) {
    const link = world.get(entity, AgentRunTargetLink);
    if (link && graph.runs.has(link.run) && link.conversation !== conversation) return 'multi_conversation_run';
  }

  for (const entity of world.query(MessageRunLink)) {
    const link = world.get(entity, MessageRunLink);
    if (!link || !graph.messages.has(link.message)) continue;
    const run = world.get(link.run, AgentRun);
    if (run && isActiveAgentRunStatus(run.status)) return 'related_agent_run_active';
    if (!graph.runs.has(link.run)) return 'external_message_run_reference';
  }

  for (const entity of world.query(ToolCallRunLink)) {
    const link = world.get(entity, ToolCallRunLink);
    if (!link || !graph.toolCalls.has(link.toolCall)) continue;
    const run = world.get(link.run, AgentRun);
    if (run && isActiveAgentRunStatus(run.status)) return 'related_agent_run_active';
    if (!graph.runs.has(link.run)) return 'external_tool_run_reference';
  }

  for (const entity of world.query(AgentRunInputRevision)) {
    const input = world.get(entity, AgentRunInputRevision);
    if (!input || (!graph.revisions.has(input.revision) && input.conversation !== conversation)) continue;
    const run = world.get(input.run, AgentRun);
    if (run && isActiveAgentRunStatus(run.status)) return 'related_agent_run_active';
    if (!graph.runs.has(input.run)) return 'external_input_revision_reference';
  }

  if (hasActiveQueueItems(world, AgentRunQueueOrder, conversation, graph.runs)
    || hasActiveQueueItems(world, AgentRunQueueHold, conversation, graph.runs)
    || hasActiveQueueItems(world, AgentRunQueuedInput, conversation, graph.runs)) {
    return 'agent_run_queued';
  }

  for (const entity of world.query(LlmRequest)) {
    const request = world.get(entity, LlmRequest);
    if (request && (request.conversation === conversation || graph.messages.has(request.modelMessage) || graph.runs.has(request.run))) {
      return 'llm_request_active';
    }
  }

  for (const toolCall of graph.toolCalls) {
    const state = world.get(toolCall, ToolState);
    if (world.has(toolCall, InFlight) || (state && !isTerminalToolStatus(state.status))) return 'tool_call_active';
  }

  for (const block of graph.compressionBlocks) {
    const record = world.get(block, CompressionBlock);
    if (record?.status === 'pending' || record?.status === 'running') return 'compression_active';
  }

  for (const entity of world.query(RunCompressionBlockLink)) {
    const link = world.get(entity, RunCompressionBlockLink);
    if (!link || !graph.compressionBlocks.has(link.block)) continue;
    const run = world.get(link.run, AgentRun);
    if (run && isActiveAgentRunStatus(run.status)) return 'related_agent_run_active';
    if (!graph.runs.has(link.run)) return 'external_compression_run_reference';
  }

  for (const entity of world.query(CompressionBlockSourceLink)) {
    const link = world.get(entity, CompressionBlockSourceLink);
    if (!link || link.source === undefined || !graph.compressionBlocks.has(link.source)) continue;
    if (!graph.compressionBlocks.has(link.block)) return 'external_compression_source_reference';
  }

  for (const entity of world.query(Checkpoint)) {
    const checkpoint = world.get(entity, Checkpoint);
    if (checkpoint?.conversation === conversation && checkpoint.status === 'pending') return 'checkpoint_active';
  }

  for (const entity of world.query(CheckpointBarrier)) {
    const barrier = world.get(entity, CheckpointBarrier);
    if (!barrier || !checkpointBarrierTouchesGraph(barrier, graph)) continue;
    if (barrier.status !== 'released') return 'checkpoint_barrier_active';
  }

  const linkedInvocations = invocationEntitiesForGraph(world, graph);
  for (const invocation of linkedInvocations) {
    const record = world.get(invocation, LlmInvocation);
    if (record && record.status !== 'complete' && record.status !== 'error' && record.status !== 'cancelled') {
      return 'llm_invocation_active';
    }
  }

  const runByDeliveryPolicy = new Map<Entity, Entity>();
  for (const entity of world.query(RunDeliveryPolicyLink)) {
    const link = world.get(entity, RunDeliveryPolicyLink);
    if (link) runByDeliveryPolicy.set(link.policy, link.run);
  }
  for (const policyEntity of world.query(RunDeliveryPolicy)) {
    const policy = world.get(policyEntity, RunDeliveryPolicy);
    if (!policy?.targetToolCall || !graph.toolCalls.has(policy.targetToolCall)) continue;
    const run = runByDeliveryPolicy.get(policyEntity);
    if (run !== undefined && !graph.runs.has(run)) return 'external_delivery_policy_reference';
  }

  return undefined;
}

/** 按 conversation 聚合边界移除可从磁盘恢复的详情，保留 Conversation 与独立骨架关系。 */
export function evictConversationDetail(world: World, conversation: Entity): ConversationDetailEvictionResult {
  const graph = buildConversationDetailGraph(world, conversation);
  const entities = collectDetailEntities(world, graph);
  normalizeStableReferences(world, entities);
  for (const entity of entities) world.despawn(entity);
  return { removedEntities: entities.size };
}

function buildConversationDetailGraph(world: World, conversation: Entity): ConversationDetailGraph {
  const messages = new Set<Entity>();
  for (const entity of world.query(Message, PartOf)) {
    if (world.get(entity, PartOf)?.parent === conversation) messages.add(entity);
  }

  const revisions = new Set<Entity>();
  for (const entity of world.query(MessageRevision, PartOf)) {
    const parent = world.get(entity, PartOf)?.parent;
    if (parent !== undefined && messages.has(parent)) revisions.add(entity);
  }

  const toolCalls = new Set<Entity>();
  for (const entity of world.query(ToolCall, PartOf)) {
    const parent = world.get(entity, PartOf)?.parent;
    if (parent !== undefined && messages.has(parent)) toolCalls.add(entity);
  }

  const runsWithTargets = new Set<Entity>();
  const runs = new Set<Entity>();
  for (const entity of world.query(AgentRunTargetLink)) {
    const link = world.get(entity, AgentRunTargetLink);
    if (!link) continue;
    runsWithTargets.add(link.run);
    if (link.conversation === conversation) runs.add(link.run);
  }
  for (const entity of world.query(MessageRunLink)) {
    const link = world.get(entity, MessageRunLink);
    if (link && messages.has(link.message) && !runsWithTargets.has(link.run)) runs.add(link.run);
  }
  for (const entity of world.query(ToolCallRunLink)) {
    const link = world.get(entity, ToolCallRunLink);
    if (link && toolCalls.has(link.toolCall) && !runsWithTargets.has(link.run)) runs.add(link.run);
  }
  for (const entity of world.query(LlmRequest)) {
    const request = world.get(entity, LlmRequest);
    if (request?.conversation === conversation && !runsWithTargets.has(request.run)) runs.add(request.run);
  }

  const compressionBlocks = new Set<Entity>();
  for (const entity of world.query(CompressionBlock)) {
    if (world.get(entity, CompressionBlock)?.conversation === conversation) compressionBlocks.add(entity);
  }

  return { conversation, messages, revisions, toolCalls, runs, compressionBlocks };
}

function collectDetailEntities(world: World, graph: ConversationDetailGraph): Set<Entity> {
  const entities = new Set<Entity>();
  addAll(entities, graph.messages);
  addAll(entities, graph.revisions);
  addAll(entities, graph.toolCalls);
  addAll(entities, graph.runs);
  addAll(entities, graph.compressionBlocks);

  addMatching(world, MessageCurrentRevisionLink, entities, (link) => graph.messages.has(link.message) || graph.revisions.has(link.revision));
  addMatching(world, ToolCallEvent, entities, (_event, entity) => {
    const parent = world.get(entity, PartOf)?.parent;
    return parent !== undefined && graph.toolCalls.has(parent);
  });

  addMatching(world, AgentRunSourceLink, entities, (link) => graph.runs.has(link.run));
  addMatching(world, AgentRunTargetLink, entities, (link) => graph.runs.has(link.run));
  addMatching(world, AgentRunQueueOrder, entities, (item) => graph.runs.has(item.run));
  addMatching(world, AgentRunQueueHold, entities, (item) => graph.runs.has(item.run));
  addMatching(world, AgentRunQueuedInput, entities, (item) => graph.runs.has(item.run));
  addMatching(world, MessageRunLink, entities, (link) => graph.runs.has(link.run) || graph.messages.has(link.message));
  addMatching(world, ToolCallRunLink, entities, (link) => graph.runs.has(link.run) || graph.toolCalls.has(link.toolCall));
  addMatching(world, AgentRunInputRevision, entities, (input) => graph.runs.has(input.run));
  addMatching(world, RunWorkflowLink, entities, (link) => graph.runs.has(link.run));
  addMatching(world, RunSystemPromptLink, entities, (link) => graph.runs.has(link.run));
  addMatching(world, RunModelProfileLink, entities, (link) => graph.runs.has(link.run));
  addMatching(world, RunToolPolicyLink, entities, (link) => graph.runs.has(link.run));
  addMatching(world, RunWorkEnvironmentLink, entities, (link) => graph.runs.has(link.run));
  addMatching(world, RunRuntimeContextSnapshotLink, entities, (link) => graph.runs.has(link.run));

  collectRunPolicyEntities(world, graph.runs, entities, RunConversationPolicyLink, RunConversationPolicy);
  collectRunPolicyEntities(world, graph.runs, entities, RunContextPolicyLink, RunContextPolicy);
  collectRunPolicyEntities(world, graph.runs, entities, RunDeliveryPolicyLink, RunDeliveryPolicy);
  collectRunPolicyEntities(world, graph.runs, entities, RunEditPolicyLink, RunEditPolicy);

  addMatching(world, CompressionBlockSourceLink, entities, (link) => graph.compressionBlocks.has(link.block));
  addMatching(world, CompressionContextVariant, entities, (variant) => graph.compressionBlocks.has(variant.block));
  addMatching(world, RunCompressionBlockLink, entities, (link) => graph.runs.has(link.run) || graph.compressionBlocks.has(link.block));

  const removableInvocationLinks = new Set<Entity>();
  addMatching(world, RunLlmInvocationLink, removableInvocationLinks, (link) => graph.runs.has(link.run));
  addMatching(world, MessageLlmInvocationLink, removableInvocationLinks, (link) => graph.messages.has(link.message));
  addMatching(world, CompressionBlockLlmInvocationLink, removableInvocationLinks, (link) => graph.compressionBlocks.has(link.block));
  addAll(entities, removableInvocationLinks);

  const invocationCandidates = invocationEntitiesForLinks(world, removableInvocationLinks);
  for (const invocation of invocationCandidates) {
    if (allInvocationReferencesAreRemovable(world, invocation, removableInvocationLinks)) entities.add(invocation);
  }

  addMatching(world, CheckpointBarrier, entities, (barrier) => barrier.status === 'released' && checkpointBarrierTouchesGraph(barrier, graph));
  return entities;
}

function normalizeStableReferences(world: World, removed: ReadonlySet<Entity>): void {
  for (const entity of world.query(CheckpointTimelineAnchor)) {
    const anchor = world.get(entity, CheckpointTimelineAnchor);
    if (!anchor) continue;
    const removeFloor = anchor.floorMessage !== undefined && removed.has(anchor.floorMessage);
    const removeRun = anchor.sourceRun !== undefined && removed.has(anchor.sourceRun);
    const removeTool = anchor.sourceToolCall !== undefined && removed.has(anchor.sourceToolCall);
    if (!removeFloor && !removeRun && !removeTool) continue;
    world.add(entity, CheckpointTimelineAnchor, {
      ...anchor,
      floorMessageId: removeFloor ? world.get(anchor.floorMessage!, Message)?.id ?? anchor.floorMessageId : anchor.floorMessageId,
      floorMessage: removeFloor ? undefined : anchor.floorMessage,
      sourceRunId: removeRun ? world.get(anchor.sourceRun!, AgentRun)?.id ?? anchor.sourceRunId : anchor.sourceRunId,
      sourceRun: removeRun ? undefined : anchor.sourceRun,
      sourceToolCallId: removeTool ? world.get(anchor.sourceToolCall!, ToolCall)?.id ?? anchor.sourceToolCallId : anchor.sourceToolCallId,
      sourceToolCall: removeTool ? undefined : anchor.sourceToolCall
    });
  }

  for (const entity of world.query(ConversationBranchLink)) {
    const link = world.get(entity, ConversationBranchLink);
    if (!link?.sourceRevision || !removed.has(link.sourceRevision)) continue;
    world.add(entity, ConversationBranchLink, {
      ...link,
      sourceRevisionId: world.get(link.sourceRevision, MessageRevision)?.id ?? link.sourceRevisionId,
      sourceRevision: undefined
    });
  }

  for (const entity of world.query(ConversationOriginLink)) {
    const link = world.get(entity, ConversationOriginLink);
    if (!link) continue;
    const removeMessage = link.sourceMessage !== undefined && removed.has(link.sourceMessage);
    const removeTool = link.sourceToolCall !== undefined && removed.has(link.sourceToolCall);
    const removeRun = link.sourceRun !== undefined && removed.has(link.sourceRun);
    if (!removeMessage && !removeTool && !removeRun) continue;
    world.add(entity, ConversationOriginLink, {
      ...link,
      sourceMessageId: removeMessage ? world.get(link.sourceMessage!, Message)?.id ?? link.sourceMessageId : link.sourceMessageId,
      sourceMessage: removeMessage ? undefined : link.sourceMessage,
      sourceToolCallId: removeTool ? world.get(link.sourceToolCall!, ToolCall)?.id ?? link.sourceToolCallId : link.sourceToolCallId,
      sourceToolCall: removeTool ? undefined : link.sourceToolCall,
      sourceRunId: removeRun ? world.get(link.sourceRun!, AgentRun)?.id ?? link.sourceRunId : link.sourceRunId,
      sourceRun: removeRun ? undefined : link.sourceRun
    });
  }

  for (const entity of world.query(AgentAnswerSubmissionLink)) {
    const link = world.get(entity, AgentAnswerSubmissionLink);
    if (!link) continue;
    const removeRun = link.submitterRun !== undefined && removed.has(link.submitterRun);
    const removeTool = link.submitterToolCall !== undefined && removed.has(link.submitterToolCall);
    if (!removeRun && !removeTool) continue;
    world.add(entity, AgentAnswerSubmissionLink, {
      ...link,
      submitterRunId: removeRun ? world.get(link.submitterRun!, AgentRun)?.id ?? link.submitterRunId : link.submitterRunId,
      submitterRun: removeRun ? undefined : link.submitterRun,
      submitterToolCallId: removeTool ? world.get(link.submitterToolCall!, ToolCall)?.id ?? link.submitterToolCallId : link.submitterToolCallId,
      submitterToolCall: removeTool ? undefined : link.submitterToolCall
    });
  }

  for (const entity of world.query(AgentAnswerTargetLink)) {
    const link = world.get(entity, AgentAnswerTargetLink);
    if (!link) continue;
    const removeRun = link.targetRun !== undefined && removed.has(link.targetRun);
    const removeTool = link.sourceToolCall !== undefined && removed.has(link.sourceToolCall);
    if (!removeRun && !removeTool) continue;
    world.add(entity, AgentAnswerTargetLink, {
      ...link,
      targetRunId: removeRun ? world.get(link.targetRun!, AgentRun)?.id ?? link.targetRunId : link.targetRunId,
      targetRun: removeRun ? undefined : link.targetRun,
      sourceToolCallId: removeTool ? world.get(link.sourceToolCall!, ToolCall)?.id ?? link.sourceToolCallId : link.sourceToolCallId,
      sourceToolCall: removeTool ? undefined : link.sourceToolCall
    });
  }

  normalizeRunScopedLink(world, removed, SystemPromptScopeLink);
  normalizeRunScopedLink(world, removed, ModelProfileScopeLink);
  normalizeRunScopedLink(world, removed, RuntimeContextScopeLink);
  normalizeRunScopedLink(world, removed, ToolPolicyScopeLink);
  normalizeRunScopedLink(world, removed, SkillPolicyScopeLink);
  normalizeRunScopedLink(world, removed, WorkEnvironmentPolicyScopeLink);
  normalizeRunScopedLink(world, removed, CheckpointPolicyScopeLink);
}

function normalizeRunScopedLink<T extends { run?: Entity; scopeId?: string }>(
  world: World,
  removed: ReadonlySet<Entity>,
  component: ComponentType<T>
): void {
  for (const entity of world.query(component)) {
    const link = world.get(entity, component);
    if (!link?.run || !removed.has(link.run)) continue;
    world.add(entity, component, {
      ...link,
      scopeId: link.scopeId ?? world.get(link.run, AgentRun)?.id,
      run: undefined
    });
  }
}

function collectRunPolicyEntities<TLink extends { run: Entity; policy: Entity }, TPolicy>(
  world: World,
  runs: ReadonlySet<Entity>,
  entities: Set<Entity>,
  linkComponent: ComponentType<TLink>,
  policyComponent: ComponentType<TPolicy>
): void {
  const candidatePolicies = new Set<Entity>();
  for (const entity of world.query(linkComponent)) {
    const link = world.get(entity, linkComponent);
    if (!link || !runs.has(link.run)) continue;
    entities.add(entity);
    candidatePolicies.add(link.policy);
  }
  for (const policy of candidatePolicies) {
    const shared = world.query(linkComponent).some((entity) => {
      const link = world.get(entity, linkComponent);
      return link?.policy === policy && !runs.has(link.run);
    });
    if (!shared && world.has(policy, policyComponent)) entities.add(policy);
  }
}

function invocationEntitiesForGraph(world: World, graph: ConversationDetailGraph): Set<Entity> {
  const links = new Set<Entity>();
  addMatching(world, RunLlmInvocationLink, links, (link) => graph.runs.has(link.run));
  addMatching(world, MessageLlmInvocationLink, links, (link) => graph.messages.has(link.message));
  addMatching(world, CompressionBlockLlmInvocationLink, links, (link) => graph.compressionBlocks.has(link.block));
  return invocationEntitiesForLinks(world, links);
}

function invocationEntitiesForLinks(world: World, links: ReadonlySet<Entity>): Set<Entity> {
  const invocations = new Set<Entity>();
  for (const entity of links) {
    const runLink = world.get(entity, RunLlmInvocationLink);
    if (runLink) invocations.add(runLink.invocation);
    const messageLink = world.get(entity, MessageLlmInvocationLink);
    if (messageLink) invocations.add(messageLink.invocation);
    const compressionLink = world.get(entity, CompressionBlockLlmInvocationLink);
    if (compressionLink) invocations.add(compressionLink.invocation);
  }
  return invocations;
}

function allInvocationReferencesAreRemovable(world: World, invocation: Entity, links: ReadonlySet<Entity>): boolean {
  if (world.query(LlmRequest).some((entity) => world.get(entity, LlmRequest)?.invocation === invocation)) return false;
  if (world.query(RunLlmInvocationLink).some((entity) => world.get(entity, RunLlmInvocationLink)?.invocation === invocation && !links.has(entity))) return false;
  if (world.query(MessageLlmInvocationLink).some((entity) => world.get(entity, MessageLlmInvocationLink)?.invocation === invocation && !links.has(entity))) return false;
  if (world.query(CompressionBlockLlmInvocationLink).some((entity) => world.get(entity, CompressionBlockLlmInvocationLink)?.invocation === invocation && !links.has(entity))) return false;
  return true;
}

function sourceLinkTouchesGraph(link: { sourceConversation?: Entity; sourceMessage?: Entity; sourceToolCall?: Entity; sourceRun?: Entity; run: Entity }, graph: ConversationDetailGraph): boolean {
  return graph.runs.has(link.run)
    || link.sourceConversation === graph.conversation
    || (link.sourceMessage !== undefined && graph.messages.has(link.sourceMessage))
    || (link.sourceToolCall !== undefined && graph.toolCalls.has(link.sourceToolCall))
    || (link.sourceRun !== undefined && graph.runs.has(link.sourceRun));
}

function sourceLinkTouchesEvictableDetail(link: { sourceMessage?: Entity; sourceToolCall?: Entity; sourceRun?: Entity }, graph: ConversationDetailGraph): boolean {
  return (link.sourceMessage !== undefined && graph.messages.has(link.sourceMessage))
    || (link.sourceToolCall !== undefined && graph.toolCalls.has(link.sourceToolCall))
    || (link.sourceRun !== undefined && graph.runs.has(link.sourceRun));
}

function checkpointBarrierTouchesGraph(
  barrier: { conversation?: Entity; targetRun?: Entity; targetToolCall?: Entity; targetMessage?: Entity },
  graph: ConversationDetailGraph
): boolean {
  return barrier.conversation === graph.conversation
    || (barrier.targetRun !== undefined && graph.runs.has(barrier.targetRun))
    || (barrier.targetToolCall !== undefined && graph.toolCalls.has(barrier.targetToolCall))
    || (barrier.targetMessage !== undefined && graph.messages.has(barrier.targetMessage));
}

function hasActiveQueueItems<T extends { conversation: Entity; run: Entity }>(
  world: World,
  component: ComponentType<T>,
  conversation: Entity,
  runs: ReadonlySet<Entity>
): boolean {
  return world.query(component).some((entity) => {
    const item = world.get(entity, component);
    if (!item || (item.conversation !== conversation && !runs.has(item.run))) return false;
    const run = world.get(item.run, AgentRun);
    return !run || isActiveAgentRunStatus(run.status);
  });
}

function addMatching<T>(
  world: World,
  component: ComponentType<T>,
  target: Set<Entity>,
  predicate: (value: T, entity: Entity) => boolean
): void {
  for (const entity of world.query(component)) {
    const value = world.get(entity, component);
    if (value !== undefined && predicate(value, entity)) target.add(entity);
  }
}

function addAll(target: Set<Entity>, source: Iterable<Entity>): void {
  for (const entity of source) target.add(entity);
}

function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'stale';
}
