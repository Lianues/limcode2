import type {
  ClientState,
  ConversationBranchLinkRecord,
  ConversationOriginLinkRecord,
  ConversationRecord,
  ConversationReuseLinkRecord,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { ToolCall } from '../tools/components';
import { Conversation, ConversationBranchLink, ConversationOriginLink, ConversationReuseLink, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from './components';

export const chatStateProjectionReads: AccessDeclaration = {
  components: [Agent, AgentRun, ToolCall, Message, MessageRevision, MessageCurrentRevisionLink, PartOf, Conversation, ConversationReuseLink, ConversationBranchLink, ConversationOriginLink]
};

export function projectChatState(world: WorldReader): Partial<ClientState> {
  const conversations: ConversationRecord[] = world.query(Conversation).map((entity) => ({
    id: world.get(entity, Conversation)!.id,
    title: world.get(entity, Conversation)!.title,
    visibility: world.get(entity, Conversation)!.visibility
  }));

  const conversationReuseLinks: ConversationReuseLinkRecord[] = world
    .query(ConversationReuseLink)
    .map((entity) => buildConversationReuseLinkRecord(world, entity))
    .filter((item): item is ConversationReuseLinkRecord => item !== undefined);

  const conversationBranchLinks: ConversationBranchLinkRecord[] = world
    .query(ConversationBranchLink)
    .map((entity) => buildConversationBranchLinkRecord(world, entity))
    .filter((item): item is ConversationBranchLinkRecord => item !== undefined);

  const conversationOriginLinks: ConversationOriginLinkRecord[] = world
    .query(ConversationOriginLink)
    .map((entity) => buildConversationOriginLinkRecord(world, entity))
    .filter((item): item is ConversationOriginLinkRecord => item !== undefined);

  const messages: MessageRecord[] = world
    .query(Message, PartOf)
    .filter((entity) => world.has(world.get(entity, PartOf)!.parent, Conversation))
    .map((entity) => {
      const message = world.get(entity, Message)!;
      const conversationEntity = world.get(entity, PartOf)!.parent;
      return {
        id: message.id,
        conversationId: world.get(conversationEntity, Conversation)!.id,
        role: message.role,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
        ...(message.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: message.streamOutputDurationMs } : {}),
        ...(message.usageMetadata !== undefined ? { usageMetadata: message.usageMetadata } : {}),
        ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
        seq: message.seq
      };
    })
    .sort((a, b) => a.seq - b.seq);

  const messageRevisions: MessageRevisionRecord[] = world
    .query(MessageRevision, PartOf)
    .map((entity) => buildMessageRevisionRecord(world, entity))
    .filter((item): item is MessageRevisionRecord => item !== undefined);

  const messageCurrentRevisionLinks: MessageCurrentRevisionLinkRecord[] = world
    .query(MessageCurrentRevisionLink)
    .map((entity) => buildMessageCurrentRevisionLinkRecord(world, entity))
    .filter((item): item is MessageCurrentRevisionLinkRecord => item !== undefined);

  return { conversations, conversationReuseLinks, conversationBranchLinks, conversationOriginLinks, messages, messageRevisions, messageCurrentRevisionLinks };
}

function buildConversationReuseLinkRecord(world: WorldReader, entity: number): ConversationReuseLinkRecord | undefined {
  const link = world.get(entity, ConversationReuseLink);
  if (!link) return undefined;
  const conversation = world.get(link.conversation, Conversation);
  if (!conversation) return undefined;
  const agent = link.agent !== undefined ? world.get(link.agent, Agent) : undefined;
  return { id: link.id, key: link.key, conversationId: conversation.id, ...(agent ? { agentId: agent.id } : {}) };
}

function buildConversationBranchLinkRecord(world: WorldReader, entity: number): ConversationBranchLinkRecord | undefined {
  const link = world.get(entity, ConversationBranchLink);
  if (!link) return undefined;
  const sourceConversation = world.get(link.sourceConversation, Conversation);
  const targetConversation = world.get(link.targetConversation, Conversation);
  const sourceRevision = link.sourceRevision !== undefined ? world.get(link.sourceRevision, MessageRevision) : undefined;
  if (!sourceConversation || !targetConversation) return undefined;
  return { id: link.id, sourceConversationId: sourceConversation.id, targetConversationId: targetConversation.id, ...(sourceRevision ? { sourceRevisionId: sourceRevision.id } : {}), kind: link.kind };
}

function buildConversationOriginLinkRecord(world: WorldReader, entity: number): ConversationOriginLinkRecord | undefined {
  const link = world.get(entity, ConversationOriginLink);
  if (!link) return undefined;
  const conversation = world.get(link.conversation, Conversation);
  if (!conversation) return undefined;
  return {
    id: link.id,
    conversationId: conversation.id,
    originKind: link.originKind,
    ...(link.sourceKind !== undefined ? { sourceKind: link.sourceKind } : {}),
    ...optionalId('sourceAgentId', link.sourceAgent !== undefined ? world.get(link.sourceAgent, Agent)?.id : link.sourceAgentId),
    ...optionalId('sourceConversationId', link.sourceConversation !== undefined ? world.get(link.sourceConversation, Conversation)?.id : link.sourceConversationId),
    ...optionalId('sourceMessageId', link.sourceMessage !== undefined ? world.get(link.sourceMessage, Message)?.id : link.sourceMessageId),
    ...optionalId('sourceToolCallId', link.sourceToolCall !== undefined ? world.get(link.sourceToolCall, ToolCall)?.id : link.sourceToolCallId),
    ...optionalId('sourceRunId', link.sourceRun !== undefined ? world.get(link.sourceRun, AgentRun)?.id : link.sourceRunId),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function optionalId<TKey extends 'sourceAgentId' | 'sourceConversationId' | 'sourceMessageId' | 'sourceToolCallId' | 'sourceRunId'>(key: TKey, value: string | undefined): Record<TKey, string> | Record<string, never> {
  return value ? { [key]: value } as Record<TKey, string> : {};
}

function buildMessageRevisionRecord(world: WorldReader, entity: number): MessageRevisionRecord | undefined {
  const revision = world.get(entity, MessageRevision);
  const messageEntity = world.get(entity, PartOf)?.parent;
  if (!revision || messageEntity === undefined) return undefined;
  const message = world.get(messageEntity, Message);
  const conversationEntity = messageEntity === undefined ? undefined : world.get(messageEntity, PartOf)?.parent;
  const conversation = conversationEntity === undefined ? undefined : world.get(conversationEntity, Conversation);
  if (!message || !conversation) return undefined;
  return { id: revision.id, messageId: message.id, conversationId: conversation.id, content: revision.content, createdAt: revision.createdAt, reason: revision.reason };
}

function buildMessageCurrentRevisionLinkRecord(world: WorldReader, entity: number): MessageCurrentRevisionLinkRecord | undefined {
  const link = world.get(entity, MessageCurrentRevisionLink);
  if (!link) return undefined;
  const message = world.get(link.message, Message);
  const revision = world.get(link.revision, MessageRevision);
  if (!message || !revision) return undefined;
  return { id: link.id, messageId: message.id, revisionId: revision.id };
}


