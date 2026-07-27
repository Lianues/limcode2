import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { createStableId } from '../../../utils/stableId';
import { createMessageId, type MessageContent } from '../../../../shared/protocol';
import { requestCheckpointBarrierIfEnabled } from '../checkpoint/barriers';
import { Checkpoint } from '../checkpoint/components';
import { CheckpointEventType } from '../checkpoint/events';
import { evaluateCheckpointRequestPolicy } from '../checkpoint/queries';
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
  if (needsInitialCheckpoint) requestInitialCheckpoint(world, cmd, conversationId, conversation);
  requestUserMessageCheckpoints(world, cmd, conversationId, conversation, message, messageId);
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

function requestInitialCheckpoint(world: WorldReader, cmd: CommandSink, conversationId: string, conversation: Entity): void {
  if (!evaluateCheckpointRequestPolicy(world, { conversation, trigger: 'conversation_initial' }).enabled) return;
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId, trigger: 'conversation_initial' }
  });
}

function requestUserMessageCheckpoints(world: WorldReader, cmd: CommandSink, conversationId: string, conversation: Entity, floorMessage: Entity, floorMessageId: string): void {
  const beforeCheckpointId = createMessageId();
  requestCheckpointBarrierIfEnabled(world, cmd, {
    barrier: {
      checkpointId: beforeCheckpointId,
      conversation,
      trigger: 'user_message_before',
      targetKind: 'message_llm',
      targetMessage: floorMessage,
      targetMessageId: floorMessageId
    },
    request: { conversationId, floorMessageId, anchorPosition: 'before' }
  });

  if (evaluateCheckpointRequestPolicy(world, { conversation, trigger: 'user_message_after' }).enabled) {
    cmd.enqueue({
      type: CheckpointEventType.Requested,
      payload: { conversationId, trigger: 'user_message_after', floorMessageId, anchorPosition: 'after' }
    });
  }
}

export function conversationIdForEntity(world: WorldReader, conversation: Entity): string | undefined {
  return world.get(conversation, Conversation)?.id;
}
