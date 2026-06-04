import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunNeedsModel,
  AgentRunSourceLink,
  MessageRunLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { cleanupRunLlmRequests } from '../../agentRun/llmRequestCleanup';
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
  AgentRunSourceLink,
  AgentRunInputRevision,
  MessageRunLink,
  ToolCallRunLink,
  ToolCall,
  ToolState,
  ToolCallEvent,
  ToolResultConsumed
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

function deleteMessagesFromIndex(world: WorldReader, cmd: CommandSink, messages: Entity[], startIndex: number): void {
  const deletedMessages = new Set(messages.slice(startIndex));
  if (deletedMessages.size === 0) return;

  const deletedRevisions = entitiesWithParent(world, MessageRevision, deletedMessages);
  const deletedToolCalls = entitiesWithParent(world, ToolCall, deletedMessages);
  const deletedToolEvents = entitiesWithParent(world, ToolCallEvent, deletedToolCalls);
  const affectedRuns = runsAffectedByDeletion(world, deletedMessages, deletedRevisions, deletedToolCalls);

  for (const run of affectedRuns) markRunStale(world, cmd, run);

  const entitiesToDespawn = new Set<Entity>();
  for (const entity of deletedMessages) entitiesToDespawn.add(entity);
  for (const entity of deletedRevisions) entitiesToDespawn.add(entity);
  for (const entity of deletedToolCalls) entitiesToDespawn.add(entity);
  for (const entity of deletedToolEvents) entitiesToDespawn.add(entity);

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

  for (const entity of entitiesToDespawn) cmd.despawn(entity);
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
