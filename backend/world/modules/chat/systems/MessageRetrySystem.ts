import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink } from '../../agent/components';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunNeedsModel,
  AgentRunQueueHold,
  AgentRunQueueOrder,
  AgentRunQueuedInput,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { AgentRunBundle, spawnAgentRun } from '../../agentRun/bundles';
import { answerBridgeIdForConversation, defaultAgentForConversation, runSource, runTarget } from '../../agentRun/queries';
import { ToolCallEventBundle } from '../../tools/bundles';
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
import { deleteMessagesFromIndex } from './MessageDeleteSystem';

const RETRY_READ_COMPONENTS = [
  Agent,
  AgentConversationLink,
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
  AgentRunTargetLink,
  AgentRunInputRevision,
  MessageRunLink,
  ToolCallRunLink,
  ToolCall,
  ToolState,
  ToolCallEvent,
  ToolResultConsumed
] as const;

/** 重试指定 model 消息：删除该消息及后续消息，再基于原 run/source 重新启动一次 AI 响应。 */
export const MessageRetrySystem = defineSystem({
  name: 'MessageRetrySystem',
  access: {
    reads: { components: RETRY_READ_COMPONENTS },
    writes: { components: RETRY_READ_COMPONENTS, mutationMode: 'delete' },
    events: { read: [ChatEventType.RetryFrom] },
    bundles: [AgentRunBundle, ToolCallEventBundle],
    effects: { emit: ['llm.abort', 'tool.abort'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ChatEventType.RetryFrom)) {
      const conversation = findConversation(world, payload.conversationId);
      if (conversation === undefined) continue;

      const messages = conversationMessages(world, conversation);
      const startIndex = messages.findIndex((entity) => world.get(entity, Message)?.id === payload.messageId);
      if (startIndex < 0) continue;

      const modelMessage = messages[startIndex];
      const modelMessageData = world.get(modelMessage, Message);
      if (!modelMessageData || modelMessageData.role !== 'model') continue;

      const retryInput = buildRetryInput(world, conversation, messages, startIndex, modelMessage);
      if (!retryInput) continue;
      deleteMessagesFromIndex(world, cmd, messages, startIndex);
      spawnAgentRun(cmd, retryInput);
    }
  }
});

type RetryInput = Parameters<typeof spawnAgentRun>[1];

function buildRetryInput(
  world: WorldReader,
  conversation: Entity,
  messages: Entity[],
  startIndex: number,
  modelMessage: Entity
): RetryInput | undefined {
  const run = runForModelMessage(world, modelMessage);
  const runData = run !== undefined ? world.get(run, AgentRun) : undefined;
  const target = run !== undefined ? runTarget(world, run) : undefined;
  const source = run !== undefined ? runSource(world, run) : undefined;
  const agent = target?.agent ?? defaultAgentForConversation(world, conversation);
  if (agent === undefined) return undefined;

  const targetConversation = target?.conversation ?? conversation;
  const sourceMessage = source?.sourceMessage ?? previousUserMessage(world, messages, startIndex);
  const answerBridgeId = source?.answerBridgeId?.trim() || answerBridgeIdForConversation(world, targetConversation);

  return {
    kind: runData?.kind ?? 'chat',
    agent,
    conversation: targetConversation,
    sourceKind: source?.sourceKind ?? 'user',
    ...(source?.sourceAgent !== undefined ? { sourceAgent: source.sourceAgent } : {}),
    sourceConversation: source?.sourceConversation ?? conversation,
    ...(sourceMessage !== undefined ? { sourceMessage, inputMessage: sourceMessage } : {}),
    ...(source?.sourceToolCall !== undefined ? { sourceToolCall: source.sourceToolCall } : {}),
    ...(answerBridgeId ? { answerBridgeId } : {}),
    ...(run !== undefined ? { sourceRun: run } : {}),
    ...(runData ? { retryOfRunId: runData.id, attempt: (runData.attempt ?? 1) + 1 } : {}),
    deliveryMode: 'direct_reply',
    includeTranscript: 'full'
  };
}

function runForModelMessage(world: WorldReader, modelMessage: Entity): Entity | undefined {
  const link = world
    .query(MessageRunLink)
    .map((entity) => world.get(entity, MessageRunLink))
    .find((candidate) => candidate?.message === modelMessage && candidate.role === 'model');
  return link?.run;
}

function previousUserMessage(world: WorldReader, messages: Entity[], startIndex: number): Entity | undefined {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const message = world.get(messages[index], Message);
    if (message?.role === 'user') return messages[index];
  }
  return undefined;
}

function findConversation(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}
