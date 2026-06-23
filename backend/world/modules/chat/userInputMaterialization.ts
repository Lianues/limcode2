import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import type { MessageContent } from '../../../../shared/protocol';
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
  const message = spawnInputMessage(cmd, conversation, content);
  if (needsInitialCheckpoint) requestInitialCheckpoint(cmd, conversationId);
  requestUserMessageCheckpoints(cmd, conversationId, message);
  return message;
}

export function spawnInputMessage(cmd: CommandSink, conversation: Entity, content: MessageContent): Entity {
  if (content.parts.length === 1 && 'text' in content.parts[0]) return spawnUserMessage(cmd, conversation, content.parts[0].text);
  return spawnUserContentMessage(cmd, conversation, content);
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

function requestUserMessageCheckpoints(cmd: CommandSink, conversationId: string, floorMessage: Entity): void {
  const floorMessageId = `m${floorMessage}`;
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId, trigger: 'user_message_before', floorMessageId, anchorPosition: 'before' }
  });

  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId, trigger: 'user_message_after', floorMessageId, anchorPosition: 'after' }
  });
}

export function conversationIdForEntity(world: WorldReader, conversation: Entity): string | undefined {
  return world.get(conversation, Conversation)?.id;
}
