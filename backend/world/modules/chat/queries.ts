import type { Entity, WorldReader } from '../../../ecs/types';
import { Conversation, ConversationOriginLink, Message, PartOf, type ConversationOriginLinkData } from './components';

export function conversationMessages(world: WorldReader, conversationEntity: Entity): Entity[] {
  return world
    .query(Message, PartOf)
    .filter((entity) => world.get(entity, PartOf)?.parent === conversationEntity)
    .sort((a, b) => (world.get(a, Message)?.seq ?? 0) - (world.get(b, Message)?.seq ?? 0));
}

/**
 * 按 ConversationOriginLink 计算对话在来源树中的归属层级。
 *
 * 语义与侧边栏历史树一致：每个对话只采用最早建立的来源 Link；缺失父项、
 * 自引用或任意祖先路径循环都会让当前对话回落为根层级，避免损坏关系导致死循环。
 */
export function conversationOriginDepth(world: WorldReader, conversationEntity: Entity): number {
  if (!world.has(conversationEntity, Conversation)) return 0;

  const conversationById = new Map<string, Entity>();
  for (const entity of world.query(Conversation)) {
    const conversation = world.get(entity, Conversation);
    if (conversation?.id) conversationById.set(conversation.id, entity);
  }

  const originByConversation = new Map<Entity, ConversationOriginLinkData>();
  for (const entity of world.query(ConversationOriginLink)) {
    const link = world.get(entity, ConversationOriginLink);
    if (!link || !world.has(link.conversation, Conversation)) continue;
    const existing = originByConversation.get(link.conversation);
    if (!existing || compareConversationOriginLinks(link, existing) < 0) {
      originByConversation.set(link.conversation, link);
    }
  }

  const parentByConversation = new Map<Entity, Entity>();
  for (const [conversation, link] of originByConversation) {
    const sourceConversation = link.sourceConversationId
      ? conversationById.get(link.sourceConversationId)
      : link.sourceConversation !== undefined && world.has(link.sourceConversation, Conversation)
        ? link.sourceConversation
        : undefined;
    if (sourceConversation === undefined || sourceConversation === conversation) continue;
    parentByConversation.set(conversation, sourceConversation);
  }

  if (conversationParentPathContainsCycle(conversationEntity, parentByConversation)) return 0;

  let depth = 0;
  let current = parentByConversation.get(conversationEntity);
  while (current !== undefined) {
    depth += 1;
    current = parentByConversation.get(current);
  }
  return depth;
}

function conversationParentPathContainsCycle(
  conversation: Entity,
  parentByConversation: ReadonlyMap<Entity, Entity>
): boolean {
  const visited = new Set<Entity>([conversation]);
  let current = parentByConversation.get(conversation);
  while (current !== undefined) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = parentByConversation.get(current);
  }
  return false;
}

function compareConversationOriginLinks(
  left: ConversationOriginLinkData,
  right: ConversationOriginLinkData
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
