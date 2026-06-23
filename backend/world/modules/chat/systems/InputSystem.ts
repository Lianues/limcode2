import { defineQuery, defineSystem, type Entity, type WorldReader, type CommandSink } from '../../../../ecs/types';
import { ChatEventType } from '../events';
import { readEvents } from '../../../events';
import { Aborted, Conversation, LlmRequest, Message, Streaming } from '../components';
import { UserMessageBundle } from '../bundles';
import { Agent, AgentConversationLink, ConversationAgentSelection } from '../../agent/components';
import { AgentRun, AgentRunNeedsModel, AgentRunTargetLink, RunEditPolicy, RunEditPolicyLink } from '../../agentRun/components';
import { AgentRunBundle, spawnAgentRun, spawnMessageRunLink } from '../../agentRun/bundles';
import { cleanupRunLlmRequests } from '../../agentRun/llmRequestCleanup';
import { defaultAgentForConversation, effectiveEditPolicyForRun, findAgentById, runTarget } from '../../agentRun/queries';
import type { ChatSendPayload, MessageContent } from '../../../../../shared/protocol';
import { CheckpointEventType } from '../../checkpoint/events';
import { Checkpoint } from '../../checkpoint/components';
import { conversationMessages } from '../queries';
import { materializeUserInputMessage } from '../userInputMaterialization';

const ConversationsByIdQuery = defineQuery({
  name: 'ConversationsById',
  all: [Conversation],
  read: [Conversation, Agent, AgentConversationLink, ConversationAgentSelection, AgentRun, AgentRunTargetLink, RunEditPolicy, RunEditPolicyLink, LlmRequest, Message, Checkpoint],
  write: [AgentRun, Message],
  remove: [AgentRunNeedsModel, Streaming, LlmRequest],
  role: 'work'
});

export const InputSystem = defineSystem({
  name: 'InputSystem',
  access: {
    queries: [ConversationsByIdQuery],
    events: { read: [ChatEventType.Send, ChatEventType.Abort], emit: [CheckpointEventType.Requested] },
    effects: { emit: ['llm.abort'] },
    writes: { components: [Aborted] },
    bundles: [UserMessageBundle, AgentRunBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ChatEventType.Send)) {
      const conversation = findConversation(world, payload.conversationId);
      if (conversation === undefined) continue;
      handleSend(world, cmd, conversation, payload);
    }

    for (const payload of readEvents(ctx, ChatEventType.Abort)) {
      const conversation = findConversation(world, payload.conversationId);
      if (conversation !== undefined) cmd.add(conversation, Aborted, true);
    }
  }
});

function handleSend(world: WorldReader, cmd: CommandSink, conversation: Entity, payload: ChatSendPayload): void {
  const agent = payload.agentId ? findAgentById(world, payload.agentId) ?? defaultAgentForConversation(world, conversation) : defaultAgentForConversation(world, conversation);
  if (agent === undefined) return;
  const content = normalizeInputContent(payload);
  if (content.parts.length === 0) return;

  const activeRuns = activeRunsForConversation(world, conversation);
  if (activeRuns.length === 0) {
    const message = materializeUserInputMessage(world, cmd, conversation, payload.conversationId, content);
    spawnChatRun(cmd, { agent, conversation, message });
    return;
  }

  const policy = effectiveEditPolicyForRun(world, activeRuns[0]);
  switch (policy.onNewUserMessageWhileRunning) {
    case 'ignore':
      return;
    case 'append_to_target': {
      const target = runTarget(world, activeRuns[0]);
      const targetConversation = target?.conversation ?? conversation;
      const targetConversationId = world.get(targetConversation, Conversation)?.id ?? payload.conversationId;
      const message = materializeUserInputMessage(world, cmd, targetConversation, targetConversationId, content);
      spawnMessageRunLink(cmd, { message, run: activeRuns[0], role: 'input' });
      return;
    }
    case 'interrupt_current': {
      cancelRuns(world, cmd, activeRuns);
      const message = materializeUserInputMessage(world, cmd, conversation, payload.conversationId, content);
      spawnChatRun(cmd, { agent, conversation, message });
      return;
    }
    case 'queue_next_run':
    default: {
      spawnQueuedChatRun(cmd, { agent, conversation, content });
      return;
    }
  }
}

function normalizeInputContent(payload: ChatSendPayload): MessageContent {
  if (payload.content?.parts?.length) {
    return { role: 'user', parts: payload.content.parts };
  }
  const text = payload.text?.trim() ?? '';
  return { role: 'user', parts: text ? [{ text }] : [] };
}

function spawnChatRun(
  cmd: CommandSink,
  input: { agent: Entity; conversation: Entity; message: Entity; needsModel?: boolean }
): Entity {
  return spawnAgentRun(cmd, {
    kind: 'chat',
    agent: input.agent,
    conversation: input.conversation,
    sourceKind: 'user',
    sourceConversation: input.conversation,
    sourceMessage: input.message,
    inputMessage: input.message,
    deliveryMode: 'direct_reply',
    includeTranscript: 'full',
    needsModel: input.needsModel
  });
}

function spawnQueuedChatRun(
  cmd: CommandSink,
  input: { agent: Entity; conversation: Entity; content: MessageContent }
): Entity {
  return spawnAgentRun(cmd, {
    kind: 'chat',
    agent: input.agent,
    conversation: input.conversation,
    sourceKind: 'user',
    sourceConversation: input.conversation,
    deliveryMode: 'direct_reply',
    includeTranscript: 'full',
    needsModel: false,
    queuedInputContent: input.content
  });
}

function cancelRuns(world: WorldReader, cmd: CommandSink, runs: Entity[]): void {
  const now = Date.now();
  for (const run of runs) {
    const data = world.get(run, AgentRun);
    if (!data || isTerminalRunStatus(data.status)) continue;
    cmd.add(run, AgentRun, { ...data, status: 'cancelled', updatedAt: now, completedAt: now, endReason: 'cancelled_by_policy', errorType: 'cancelled' });
    cmd.remove(run, AgentRunNeedsModel);
    cleanupRunLlmRequests(world, cmd, run, { kind: 'new_message_replaced' });
  }
}

function activeRunsForConversation(world: WorldReader, conversation: Entity): Entity[] {
  return world
    .query(AgentRun)
    .filter((run) => {
      const data = world.get(run, AgentRun);
      const target = runTarget(world, run);
      return !!data && !!target && target.conversation === conversation && !isTerminalRunStatus(data.status);
    })
    .sort((a, b) => (world.get(a, AgentRun)?.createdAt ?? 0) - (world.get(b, AgentRun)?.createdAt ?? 0) || a - b);
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}

function findConversation(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}
