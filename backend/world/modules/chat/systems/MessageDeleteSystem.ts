import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunNeedsModel,
  AgentRunQueueHold,
  AgentRunSourceLink,
  MessageRunLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { cleanupRunLlmRequests } from '../../agentRun/llmRequestCleanup';
import { Checkpoint, CheckpointTimelineAnchor } from '../../checkpoint/components';
import { CompressionBlock, CompressionBlockSourceLink } from '../../compression/components';
import { ToolCall, ToolCallEvent, ToolResultConsumed, ToolState } from '../../tools/components';
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
  CompressionBlockSourceLink
] as const;

/** 删除指定消息及其后的所有消息，并清理消息关联的修订、工具调用和运行链接。 */
export const MessageDeleteSystem = defineSystem({
  name: 'MessageDeleteSystem',
  access: {
    reads: { components: DELETE_READ_COMPONENTS },
    writes: { components: DELETE_READ_COMPONENTS, mutationMode: 'delete' },
    events: { read: [ChatEventType.DeleteFrom] },
    effects: { emit: ['llm.abort'] }
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
  const affectedCompressionBlocks = compressionBlocksAffectedByDeletion(world, deletedMessages);

  for (const run of affectedRuns) markRunStale(world, cmd, run);
  for (const block of affectedCompressionBlocks) markCompressionBlockStale(world, cmd, block);

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

  for (const entity of world.query(AgentRunQueueHold)) {
    const hold = world.get(entity, AgentRunQueueHold);
    if (hold && affectedRuns.includes(hold.run)) entitiesToDespawn.add(entity);
  }

  for (const entity of entitiesToDespawn) cmd.despawn(entity);
}

function compressionBlocksAffectedByDeletion(world: WorldReader, deletedMessages: ReadonlySet<Entity>): Set<Entity> {
  const blocks = new Set<Entity>();
  for (const entity of world.query(CompressionBlockSourceLink)) {
    const link = world.get(entity, CompressionBlockSourceLink);
    if (link?.source !== undefined && deletedMessages.has(link.source)) blocks.add(link.block);
  }
  return blocks;
}

function markCompressionBlockStale(world: WorldReader, cmd: CommandSink, block: Entity): void {
  const data = world.get(block, CompressionBlock);
  if (!data || data.status === 'stale') return;
  cmd.add(block, CompressionBlock, { ...data, status: 'stale', staleReason: '源消息已删除。', updatedAt: Date.now() });
}

function checkpointAnchorsForMessages(world: WorldReader, deletedMessages: ReadonlySet<Entity>): Set<Entity> {
  const result = new Set<Entity>();
  for (const entity of world.query(CheckpointTimelineAnchor)) {
    const anchor = world.get(entity, CheckpointTimelineAnchor);
    if (anchor && deletedMessages.has(anchor.floorMessage)) result.add(entity);
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

function markRunStale(world: WorldReader, cmd: CommandSink, run: Entity): void {
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
