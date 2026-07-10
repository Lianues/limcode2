import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunNeedsModel,
  AgentRunQueueHold,
  AgentRunQueueOrder,
  AgentRunQueuedInput,
  AgentRunSourceLink,
  MessageRunLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { cleanupRunLlmRequests } from '../../agentRun/llmRequestCleanup';
import { Checkpoint, CheckpointTimelineAnchor } from '../../checkpoint/components';
import {
  CompressionBlock,
  CompressionBlockLlmInvocationLink,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  RunCompressionBlockLink
} from '../../compression/components';
import { LlmInvocation } from '../../llm/components';
import { ToolCallEventBundle } from '../../tools/bundles';
import { ToolCall, ToolCallEvent, ToolResultConsumed, ToolState } from '../../tools/components';
import { interruptToolCall } from '../../tools/interrupt';
import { isTerminalToolStatus } from '../../tools/state';
import { ChatEventType } from '../events';
import { conversationMessages } from '../queries';
import {
  Conversation,
  InFlight,
  LlmRequest,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf,
  Streaming
} from '../components';

const DELETE_READ_COMPONENTS = [
  Conversation,
  Message,
  PartOf,
  MessageRevision,
  MessageCurrentRevisionLink,
  Streaming,
  LlmRequest,
  InFlight,
  AgentRun,
  AgentRunNeedsModel,
  AgentRunQueueHold,
  AgentRunQueueOrder,
  AgentRunQueuedInput,
  AgentRunSourceLink,
  AgentRunInputRevision,
  MessageRunLink,
  ToolCallRunLink,
  ToolCall,
  ToolState,
  ToolCallEvent,
  ToolResultConsumed,
  Checkpoint,
  CheckpointTimelineAnchor,
  CompressionBlock,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  RunCompressionBlockLink,
  CompressionBlockLlmInvocationLink,
  LlmInvocation
] as const;

/** 删除指定消息及其后的所有消息，并清理消息关联的修订、工具调用和运行链接。 */
export const MessageDeleteSystem = defineSystem({
  name: 'MessageDeleteSystem',
  access: {
    reads: { components: DELETE_READ_COMPONENTS },
    writes: { components: DELETE_READ_COMPONENTS, mutationMode: 'delete' },
    events: { read: [ChatEventType.DeleteFrom] },
    bundles: [ToolCallEventBundle],
    effects: { emit: ['llm.abort', 'tool.abort'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ChatEventType.DeleteFrom)) {
      const conversation = findConversation(world, payload.conversationId);
      if (conversation === undefined) continue;

      const messages = conversationMessages(world, conversation);
      const startIndex = messages.findIndex((entity) => world.get(entity, Message)?.id === payload.messageId);
      if (startIndex < 0) continue;

      deleteMessagesFromIndex(world, cmd, messages, startIndex);
    }
  }
});

export function deleteMessagesFromIndex(world: WorldReader, cmd: CommandSink, messages: Entity[], startIndex: number): void {
  deleteMessages(world, cmd, new Set(messages.slice(startIndex)));
}

function deleteMessages(world: WorldReader, cmd: CommandSink, deletedMessages: Set<Entity>): void {
  if (deletedMessages.size === 0) return;
  const deletedRevisions = entitiesWithParent(world, MessageRevision, deletedMessages);
  const deletedToolCalls = entitiesWithParent(world, ToolCall, deletedMessages);
  const deletedToolEvents = entitiesWithParent(world, ToolCallEvent, deletedToolCalls);
  const deletedCheckpointAnchors = checkpointAnchorsForMessages(world, deletedMessages);
  const deletedCheckpoints = checkpointsOrphanedByDeletedAnchors(world, deletedCheckpointAnchors);
  const affectedRuns = runsAffectedByDeletion(world, deletedMessages, deletedRevisions, deletedToolCalls);
  const compressionMatches = compressionBlockSourceMatchesForDeletion(world, deletedMessages);
  const affectedCompressionBlocks = collectDependentCompressionBlocks(world, new Set(compressionMatches.map((match) => match.block)));
  // 被删除消息下的 ToolCall 会在本次删除中 despawn，因此只需要尽力中断外部运行时，
  // 不再补 ToolCallEvent，避免新事件的 PartOf 指向随后被删除的 ToolCall。
  abortDeletedOpenToolCalls(world, cmd, deletedToolCalls);
  for (const run of affectedRuns) markRunStale(world, cmd, run, deletedToolCalls);
  deleteCompressionBlocksCascade(world, cmd, affectedCompressionBlocks);

  const entitiesToDespawn = new Set<Entity>();
  for (const entity of deletedMessages) entitiesToDespawn.add(entity);
  for (const entity of deletedRevisions) entitiesToDespawn.add(entity);
  for (const entity of deletedToolCalls) entitiesToDespawn.add(entity);
  for (const entity of deletedToolEvents) entitiesToDespawn.add(entity);
  for (const entity of deletedCheckpointAnchors) entitiesToDespawn.add(entity);
  for (const entity of deletedCheckpoints) entitiesToDespawn.add(entity);

  for (const entity of world.query(MessageCurrentRevisionLink)) {
    const link = world.get(entity, MessageCurrentRevisionLink);
    if (!link) continue;
    if (deletedMessages.has(link.message) || deletedRevisions.has(link.revision)) entitiesToDespawn.add(entity);
  }

  for (const entity of world.query(MessageRunLink)) {
    const link = world.get(entity, MessageRunLink);
    if (link && deletedMessages.has(link.message)) entitiesToDespawn.add(entity);
  }

  for (const entity of world.query(ToolCallRunLink)) {
    const link = world.get(entity, ToolCallRunLink);
    if (link && deletedToolCalls.has(link.toolCall)) entitiesToDespawn.add(entity);
  }

  for (const entity of world.query(AgentRunInputRevision)) {
    const input = world.get(entity, AgentRunInputRevision);
    if (input && deletedRevisions.has(input.revision)) entitiesToDespawn.add(entity);
  }

  for (const entity of world.query(LlmRequest)) {
    const request = world.get(entity, LlmRequest);
    if (request && deletedMessages.has(request.modelMessage)) entitiesToDespawn.add(entity);
  }

  const affectedRunSet = new Set(affectedRuns);
  for (const entity of world.query(AgentRunQueueHold)) {
    const hold = world.get(entity, AgentRunQueueHold);
    if (hold && affectedRunSet.has(hold.run)) entitiesToDespawn.add(entity);
  }
  for (const entity of world.query(AgentRunQueueOrder)) {
    const order = world.get(entity, AgentRunQueueOrder);
    if (order && affectedRunSet.has(order.run)) entitiesToDespawn.add(entity);
  }
  for (const entity of world.query(AgentRunQueuedInput)) {
    const input = world.get(entity, AgentRunQueuedInput);
    if (input && affectedRunSet.has(input.run)) entitiesToDespawn.add(entity);
  }

  for (const entity of entitiesToDespawn) cmd.despawn(entity);
}

interface CompressionDeletionMatch {
  block: Entity;
  sourceMessageId: string;
  role?: string;
  order?: number;
}

function compressionBlockSourceMatchesForDeletion(world: WorldReader, deletedMessages: ReadonlySet<Entity>): CompressionDeletionMatch[] {
  const matches: CompressionDeletionMatch[] = [];
  const seen = new Set<string>();
  const deletedMessageIds = new Set(
    [...deletedMessages]
      .map((entity) => world.get(entity, Message)?.id)
      .filter((id): id is string => !!id)
  );
  for (const entity of world.query(CompressionBlockSourceLink)) {
    const link = world.get(entity, CompressionBlockSourceLink);
    if (!link || link.sourceKind !== 'message') continue;
    const sourceDeleted = (link.source !== undefined && deletedMessages.has(link.source)) || deletedMessageIds.has(link.sourceId);
    if (!sourceDeleted) continue;
    const key = `${link.block}:${link.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ block: link.block, sourceMessageId: link.sourceId, role: link.role, order: link.order });
  }
  return matches;
}

function deleteCompressionBlocksCascade(world: WorldReader, cmd: CommandSink, initial: ReadonlySet<Entity>): void {
  if (initial.size === 0) return;
  const blocks = collectDependentCompressionBlocks(world, initial);
  const entitiesToDespawn = new Set<Entity>(blocks);

  for (const block of blocks) {
    const data = world.get(block, CompressionBlock);
    if (data?.status === 'pending' || data?.status === 'running') {
      cmd.effect({ kind: 'llm.abort', requestId: `compact-${data.id}` });
    }
  }

  for (const entity of world.query(CompressionBlockSourceLink)) {
    const link = world.get(entity, CompressionBlockSourceLink);
    if (link && blocks.has(link.block)) entitiesToDespawn.add(entity);
  }

  for (const entity of world.query(CompressionContextVariant)) {
    const variant = world.get(entity, CompressionContextVariant);
    if (variant && blocks.has(variant.block)) entitiesToDespawn.add(entity);
  }

  for (const entity of world.query(RunCompressionBlockLink)) {
    const link = world.get(entity, RunCompressionBlockLink);
    if (link && blocks.has(link.block)) entitiesToDespawn.add(entity);
  }

  for (const entity of world.query(CompressionBlockLlmInvocationLink)) {
    const link = world.get(entity, CompressionBlockLlmInvocationLink);
    if (!link || !blocks.has(link.block)) continue;
    entitiesToDespawn.add(link.invocation);
    entitiesToDespawn.add(entity);
  }

  for (const entity of entitiesToDespawn) cmd.despawn(entity);
}

function collectDependentCompressionBlocks(world: WorldReader, initial: ReadonlySet<Entity>): Set<Entity> {
  const all = new Set(initial);
  const queue = [...initial];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentId = world.get(current, CompressionBlock)?.id;
    for (const entity of world.query(CompressionBlockSourceLink)) {
      const link = world.get(entity, CompressionBlockSourceLink);
      if (!link || link.sourceKind !== 'compressionBlock' || all.has(link.block)) continue;
      if (link.source !== current && link.sourceId !== currentId) continue;
      all.add(link.block);
      queue.push(link.block);
    }
  }
  return all;
}

function checkpointAnchorsForMessages(world: WorldReader, deletedMessages: ReadonlySet<Entity>): Set<Entity> {
  const result = new Set<Entity>();
  for (const entity of world.query(CheckpointTimelineAnchor)) {
    const anchor = world.get(entity, CheckpointTimelineAnchor);
    if (anchor?.floorMessage !== undefined && deletedMessages.has(anchor.floorMessage)) result.add(entity);
  }
  return result;
}

function checkpointsOrphanedByDeletedAnchors(world: WorldReader, deletedAnchors: ReadonlySet<Entity>): Set<Entity> {
  const candidates = new Set<Entity>();
  for (const entity of deletedAnchors) {
    const anchor = world.get(entity, CheckpointTimelineAnchor);
    if (anchor) candidates.add(anchor.checkpoint);
  }
  if (candidates.size === 0) return candidates;

  for (const entity of world.query(CheckpointTimelineAnchor)) {
    if (deletedAnchors.has(entity)) continue;
    const anchor = world.get(entity, CheckpointTimelineAnchor);
    if (anchor) candidates.delete(anchor.checkpoint);
  }
  return candidates;
}

function runsAffectedByDeletion(
  world: WorldReader,
  deletedMessages: ReadonlySet<Entity>,
  deletedRevisions: ReadonlySet<Entity>,
  deletedToolCalls: ReadonlySet<Entity>
): Entity[] {
  const runs = new Set<Entity>();

  for (const entity of world.query(MessageRunLink)) {
    const link = world.get(entity, MessageRunLink);
    if (link && deletedMessages.has(link.message)) runs.add(link.run);
  }

  for (const entity of world.query(ToolCallRunLink)) {
    const link = world.get(entity, ToolCallRunLink);
    if (link && deletedToolCalls.has(link.toolCall)) runs.add(link.run);
  }

  for (const entity of world.query(AgentRunSourceLink)) {
    const link = world.get(entity, AgentRunSourceLink);
    if (!link) continue;
    if (
      (link.sourceMessage !== undefined && deletedMessages.has(link.sourceMessage)) ||
      (link.sourceToolCall !== undefined && deletedToolCalls.has(link.sourceToolCall))
    ) {
      runs.add(link.run);
    }
  }

  for (const entity of world.query(AgentRunInputRevision)) {
    const input = world.get(entity, AgentRunInputRevision);
    if (input && deletedRevisions.has(input.revision)) runs.add(input.run);
  }

  for (const entity of world.query(LlmRequest)) {
    const request = world.get(entity, LlmRequest);
    if (request && deletedMessages.has(request.modelMessage)) runs.add(request.run);
  }

  return [...runs].sort((left, right) => left - right);
}

function markRunStale(world: WorldReader, cmd: CommandSink, run: Entity, excludedToolCalls: ReadonlySet<Entity>): void {
  const data = world.get(run, AgentRun);
  if (!data || isTerminalRunStatus(data.status)) return;

  const now = Date.now();
  cmd.add(run, AgentRun, {
    ...data,
    status: 'stale',
    updatedAt: now,
    completedAt: now,
    endReason: 'stale_source_edited',
    errorType: 'stale'
  });
  cmd.remove(run, AgentRunNeedsModel);
  cleanupRunLlmRequests(world, cmd, run, { kind: 'stale' });
  failOpenToolCallsForRun(world, cmd, run, excludedToolCalls);
}

function abortDeletedOpenToolCalls(world: WorldReader, cmd: CommandSink, deletedToolCalls: ReadonlySet<Entity>): void {
  for (const entity of deletedToolCalls) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state || isTerminalToolStatus(state.status)) continue;
    cmd.effect({ kind: 'tool.abort', toolCallId: call.id });
  }
}

function failOpenToolCallsForRun(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  excludedToolCalls: ReadonlySet<Entity>
): void {
  const toolCallEntitiesInRun = new Set(
    world
      .query(ToolCallRunLink)
      .filter((entity) => world.get(entity, ToolCallRunLink)?.run === run)
      .map((entity) => world.get(entity, ToolCallRunLink)?.toolCall)
      .filter((entity): entity is Entity => entity !== undefined)
  );
  for (const entity of world.query(ToolCall, ToolState)) {
    if (excludedToolCalls.has(entity) || !toolCallEntitiesInRun.has(entity)) continue;
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);

    if (!call || !state) continue;
    interruptToolCall(cmd, entity, call, state, { emitAbort: true });
  }
}
function entitiesWithParent(
  world: WorldReader,
  component: typeof MessageRevision | typeof ToolCall | typeof ToolCallEvent,
  parents: ReadonlySet<Entity>
): Set<Entity> {
  const result = new Set<Entity>();
  for (const entity of world.query(component, PartOf)) {
    const parent = world.get(entity, PartOf)?.parent;
    if (parent !== undefined && parents.has(parent)) result.add(entity);
  }
  return result;
}

function findConversation(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}
