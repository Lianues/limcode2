import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { createStableId } from '../../../utils/stableId';
import { createMessageId, type MessageContent } from '../../../../shared/protocol';
import { spawnCheckpointBarrier } from '../checkpoint/barriers';
import { Checkpoint } from '../checkpoint/components';
import { CheckpointEventType } from '../checkpoint/events';
import { spawnUserContentMessage, spawnUserMessage } from './bundles';
import { Conversation } from './components';
import { conversationMessages } from './queries';

export function materializeUserInputMessage(
  world: WorldReader,
  cmd: CommandSink,
  conversation: Entity,
  conversationId: string,
  content: MessageContent
): Entity {
  const isFirstMessage = conversationMessages(world, conversation).length === 0;
  const needsInitialCheckpoint = isFirstMessage && !hasInitialCheckpoint(world, conversation);
  const messageId = createStableId('msg');
  const message = spawnInputMessage(cmd, conversation, content, messageId);
  if (needsInitialCheckpoint) requestInitialCheckpoint(cmd, conversationId);
  requestUserMessageCheckpoints(cmd, conversationId, conversation, message, messageId);
  return message;
}

export function spawnInputMessage(cmd: CommandSink, conversation: Entity, content: MessageContent, messageId?: string): Entity {
  if (content.parts.length === 1 && 'text' in content.parts[0]) return spawnUserMessage(cmd, conversation, content.parts[0].text, messageId);
  return spawnUserContentMessage(cmd, conversation, content, messageId);
}

function hasInitialCheckpoint(world: WorldReader, conversation: Entity): boolean {
  return world.query(Checkpoint).some((entity) => {
    const checkpoint = world.get(entity, Checkpoint);
    return checkpoint?.conversation === conversation && checkpoint.trigger === 'conversation_initial';
  });
}

function requestInitialCheckpoint(cmd: CommandSink, conversationId: string): void {
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId, trigger: 'conversation_initial' }
  });
}

function requestUserMessageCheckpoints(cmd: CommandSink, conversationId: string, conversation: Entity, floorMessage: Entity, floorMessageId: string): void {
  const beforeCheckpointId = createMessageId();
  spawnCheckpointBarrier(cmd, {
    checkpointId: beforeCheckpointId,
    conversation,
    trigger: 'user_message_before',
    targetKind: 'message_llm',
    targetMessage: floorMessage,
    targetMessageId: floorMessageId
  });
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { checkpointId: beforeCheckpointId, conversationId, trigger: 'user_message_before', floorMessageId, anchorPosition: 'before' }
  });

  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId, trigger: 'user_message_after', floorMessageId, anchorPosition: 'after' }
  });
}

export function conversationIdForEntity(world: WorldReader, conversation: Entity): string | undefined {
  return world.get(conversation, Conversation)?.id;
}
