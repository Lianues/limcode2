import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink } from '../../agent/components';
import { linkAgentToConversation, AgentFromBlueprintBundle } from '../../agent/bundles';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunNeedsModel,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink
} from '../../agentRun/components';
import { AgentRunBundle, markRunNeedsModel, spawnAgentRun, spawnMessageRunLink } from '../../agentRun/bundles';
import { cleanupRunLlmRequests } from '../../agentRun/llmRequestCleanup';
import { activeDeliveryPolicyForRun, defaultAgentForConversation, effectiveEditPolicyForRun, runSource, runTarget } from '../../agentRun/queries';
import type { MessageContent } from '../../../../../shared/protocol';
import {
  cloneMessageToConversation,
  ConversationBundle,
  ConversationLinkBundle,
  MessageBundle,
  spawnConversation,
  spawnConversationBranchLink,
  estimateUserInputUsage,
  spawnMessageRevision,
  spawnUserMessage,
  UserMessageBundle
} from '../bundles';
import { ChatEventType } from '../events';
import { conversationMessages } from '../queries';
import { deleteMessagesFromIndex } from './MessageDeleteSystem';
import { Conversation, LlmRequest, Message, MessageCurrentRevisionLink, MessageRevision, PartOf, Streaming } from '../components';

const MessageEditQuery = defineQuery({
  name: 'MessageEditLookup',
  all: [Message, PartOf],
  read: [
    Agent,
    AgentConversationLink,
    Conversation,
    Message,
    PartOf,
    MessageRevision,
    MessageCurrentRevisionLink,
    AgentRun,
    AgentRunInputRevision,
    AgentRunSourceLink,
    AgentRunTargetLink,
    MessageRunLink,
    RunEditPolicy,
    RunEditPolicyLink,
    RunDeliveryPolicy,
    RunDeliveryPolicyLink,
    LlmRequest
  ],
  write: [Message, AgentRun],
  remove: [MessageCurrentRevisionLink, AgentRunNeedsModel, Streaming, LlmRequest],
  mutationMode: 'update',
  role: 'work'
});

export const MessageEditSystem = defineSystem({
  name: 'MessageEditSystem',
  access: {
    queries: [MessageEditQuery],
    effects: { emit: ['llm.abort'] },
    events: { read: [ChatEventType.Edit] },
    bundles: [MessageBundle, UserMessageBundle, ConversationBundle, ConversationLinkBundle, AgentRunBundle, AgentFromBlueprintBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ChatEventType.Edit)) {
      const conversation = findConversation(world, payload.conversationId);
      if (conversation === undefined) continue;
      const message = findMessage(world, conversation, payload.messageId);
      if (message === undefined) continue;
      const current = world.get(message, Message);
      if (!current || current.status === 'streaming') continue;

      const text = payload.text?.trim() ?? '';
      const content: MessageContent = payload.content?.parts?.length
        ? { role: current.content.role, parts: payload.content.parts }
        : { role: current.content.role, parts: text ? [{ text }] : [] };
      if (content.parts.length === 0) continue;
      const oldRevision = currentRevisionForMessage(world, message);
      for (const link of currentRevisionLinksForMessage(world, message)) cmd.remove(link, MessageCurrentRevisionLink);
      const usageMetadata = current.role === 'user' ? estimateUserInputUsage(visibleText(content)) : current.usageMetadata;
      cmd.add(message, Message, { ...current, content, status: 'complete', usageMetadata });
      const newRevision = spawnMessageRevision(cmd, message, content, 'edited');
      applySourceEditedPolicies(world, cmd, { message, conversation, oldRevision, newRevision, content });

      if (payload.deleteFollowing) {
        const messages = conversationMessages(world, conversation);
        const editedIndex = messages.indexOf(message);
        if (editedIndex >= 0) deleteMessagesFromIndex(world, cmd, messages, editedIndex + 1);
      }

      if (payload.runAfterEdit && current.role === 'user') {
        spawnEditedMessageRun(world, cmd, conversation, message);
      }
    }
  }
});

function visibleText(content: MessageContent): string {
  return content.parts.map((part) => {
    if ('text' in part && part.thought !== true) return part.text;
    return '';
  }).join('\n');
}

function spawnEditedMessageRun(world: WorldReader, cmd: CommandSink, conversation: Entity, message: Entity): void {
  const agent = defaultAgentForConversation(world, conversation);
  if (agent === undefined) return;
  spawnAgentRun(cmd, {
    kind: 'chat',
    agent,
    conversation,
    sourceKind: 'user',
    sourceConversation: conversation,
    sourceMessage: message,
    inputMessage: message,
    deliveryMode: 'direct_reply',
    includeTranscript: 'full'
  });
}

function applySourceEditedPolicies(
  world: WorldReader,
  cmd: CommandSink,
  input: { message: Entity; conversation: Entity; oldRevision?: Entity; newRevision: Entity; content: MessageContent }
): void {
  const affectedRuns = affectedRunsForEdit(world, input.message, input.oldRevision);
  for (const run of affectedRuns) {
    const policy = effectiveEditPolicyForRun(world, run);
    switch (policy.onSourceEdited) {
      case 'ignore_snapshot':
        break;
      case 'abort_and_restart':
        cancelRun(world, cmd, run);
        restartRun(world, cmd, run, input.message);
        break;
      case 'append_correction':
        appendCorrection(world, cmd, run, input.message, input.content);
        break;
      case 'branch_new_run':
        markRunStatus(world, cmd, run, 'stale');
        branchNewRun(world, cmd, run, input);
        break;
      case 'mark_stale':
      default:
        markRunStatus(world, cmd, run, 'stale');
        break;
    }
  }
}

function affectedRunsForEdit(world: WorldReader, message: Entity, oldRevision: Entity | undefined): Entity[] {
  return world
    .query(AgentRun)
    .filter((run) => {
      const data = world.get(run, AgentRun);
      if (!data || isTerminalRunStatus(data.status)) return false;
      const source = runSource(world, run);
      if (source?.sourceMessage === message) return true;
      if (oldRevision === undefined) return false;
      return world.query(AgentRunInputRevision).some((entity) => {
        const input = world.get(entity, AgentRunInputRevision);
        return input?.run === run && input.revision === oldRevision;
      });
    })
    .sort((a, b) => (world.get(a, AgentRun)?.createdAt ?? 0) - (world.get(b, AgentRun)?.createdAt ?? 0) || a - b);
}

function cancelRun(world: WorldReader, cmd: CommandSink, run: Entity): void {
  markRunStatus(world, cmd, run, 'cancelled', 'cancelled_by_policy', 'cancelled');
}

function markRunStatus(world: WorldReader, cmd: CommandSink, run: Entity, status: 'cancelled' | 'stale', endReason: 'cancelled_by_policy' | 'stale_source_edited' = 'stale_source_edited', errorType: 'cancelled' | 'stale' = 'stale'): void {
  const data = world.get(run, AgentRun);
  if (!data || isTerminalRunStatus(data.status)) return;
  const now = Date.now();
  cmd.add(run, AgentRun, { ...data, status, updatedAt: now, completedAt: now, endReason, errorType });
  cmd.remove(run, AgentRunNeedsModel);
  cleanupRunLlmRequests(world, cmd, run, { kind: status === 'stale' ? 'source_edit_stale' : 'source_edit_cancelled' });
}

function restartRun(world: WorldReader, cmd: CommandSink, run: Entity, editedMessage: Entity): void {
  const target = runTarget(world, run);
  if (!target) return;
  const source = runSource(world, run);
  const data = world.get(run, AgentRun);
  const delivery = activeDeliveryPolicyForRun(world, run);
  spawnAgentRun(cmd, {
    kind: data?.kind ?? 'chat',
    agent: target.agent,
    conversation: target.conversation,
    sourceKind: source?.sourceKind ?? 'user',
    ...(source?.sourceAgent !== undefined ? { sourceAgent: source.sourceAgent } : {}),
    ...(source?.sourceConversation !== undefined ? { sourceConversation: source.sourceConversation } : { sourceConversation: target.conversation }),
    sourceMessage: source?.sourceMessage ?? editedMessage,
    ...(source?.sourceToolCall !== undefined ? { sourceToolCall: source.sourceToolCall } : {}),
    sourceRun: run,
    inputMessage: source?.sourceMessage === editedMessage ? editedMessage : undefined,
    deliveryMode: delivery?.mode ?? 'direct_reply',
    includeTranscript: delivery?.includeTranscript ?? 'full'
  });
}

function appendCorrection(world: WorldReader, cmd: CommandSink, run: Entity, editedMessage: Entity, content: MessageContent): void {
  const target = runTarget(world, run);
  if (!target) return;
  const messageRecord = world.get(editedMessage, Message);
  const text = content.parts.map((part) => 'text' in part ? part.text : '').join('');
  const correction = spawnUserMessage(cmd, target.conversation, `<message-correction>\n<message-id>${escapeXml(messageRecord?.id ?? String(editedMessage))}</message-id>\n<content>${escapeXml(text)}</content>\n</message-correction>`);
  spawnMessageRunLink(cmd, { message: correction, run, role: 'input' });
  if (!hasActiveLlmRequest(world, run)) markRunNeedsModel(cmd, run);
}

function branchNewRun(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  input: { message: Entity; conversation: Entity; newRevision: Entity; content: MessageContent }
): void {
  const target = runTarget(world, run);
  if (!target) return;
  const messageData = world.get(input.message, Message);
  if (!messageData) return;

  const branch = spawnConversation(cmd, {
    id: `conversation-branch-${messageData.id}-${Date.now().toString(36)}`,
    title: `Branch from ${messageData.id}`,
    visibility: 'collapsed'
  });
  linkAgentToConversation(cmd, { agent: target.agent, conversation: branch, role: 'default' });

  let clonedEditedMessage: Entity | undefined;
  const sourceMessages = conversationMessages(world, input.conversation);
  const cutoff = sourceMessages.indexOf(input.message);
  for (const entity of sourceMessages.slice(0, cutoff >= 0 ? cutoff + 1 : sourceMessages.length)) {
    const message = world.get(entity, Message);
    if (!message) continue;
    const cloned = cloneMessageToConversation(cmd, branch, message, entity === input.message ? input.content : undefined);
    if (entity === input.message) clonedEditedMessage = cloned;
  }

  spawnConversationBranchLink(cmd, { sourceConversation: input.conversation, targetConversation: branch, sourceRevision: input.newRevision, kind: 'branch_from_revision' });
  const delivery = activeDeliveryPolicyForRun(world, run);
  spawnAgentRun(cmd, {
    kind: 'chat',
    agent: target.agent,
    conversation: branch,
    sourceKind: 'user',
    sourceConversation: branch,
    ...(clonedEditedMessage !== undefined ? { sourceMessage: clonedEditedMessage, inputMessage: clonedEditedMessage } : {}),
    deliveryMode: delivery?.mode ?? 'direct_reply',
    includeTranscript: delivery?.includeTranscript ?? 'full'
  });
}

function hasActiveLlmRequest(world: WorldReader, run: Entity): boolean {
  return world.query(LlmRequest).some((entity) => world.get(entity, LlmRequest)?.run === run);
}

function currentRevisionForMessage(world: WorldReader, message: Entity): Entity | undefined {
  return currentRevisionLinksForMessage(world, message)
    .map((entity) => world.get(entity, MessageCurrentRevisionLink)?.revision)
    .find((revision): revision is Entity => revision !== undefined);
}

function currentRevisionLinksForMessage(world: WorldReader, message: Entity): Entity[] {
  return world.query(MessageCurrentRevisionLink).filter((entity) => world.get(entity, MessageCurrentRevisionLink)?.message === message);
}

function findConversation(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

function findMessage(world: WorldReader, conversation: Entity, messageId: string): Entity | undefined {
  return world.query(Message, PartOf).find((entity) => world.get(entity, PartOf)?.parent === conversation && world.get(entity, Message)?.id === messageId);
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
