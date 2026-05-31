import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { ChatEventType } from '../events';
import { readEvents } from '../../../events';
import { Aborted, Conversation } from '../components';
import { spawnUserMessage, UserMessageBundle } from '../bundles';
import { Agent, AgentConversationLink } from '../../agent/components';
import { AgentRunBundle, spawnAgentRun } from '../../agentRun/bundles';
import { defaultAgentForConversation } from '../../agentRun/queries';

const ConversationsByIdQuery = defineQuery({
  name: 'ConversationsById',
  all: [Conversation],
  read: [Conversation, Agent, AgentConversationLink],
  role: 'lookup'
});

export const InputSystem = defineSystem({
  name: 'InputSystem',
  worker: { modulePath: '../world/modules/chat/systems/InputSystem', exportName: 'InputSystem' },
  access: {
    queries: [ConversationsByIdQuery],
    events: { read: [ChatEventType.Send, ChatEventType.Abort] },
    writes: { components: [Aborted] },
    bundles: [UserMessageBundle, AgentRunBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ChatEventType.Send)) {
      const conversation = findConversation(world, payload.conversationId);
      if (conversation === undefined) continue;
      const agent = defaultAgentForConversation(world, conversation);
      if (agent === undefined) continue;
      const message = spawnUserMessage(cmd, conversation, payload.text);
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

    for (const payload of readEvents(ctx, ChatEventType.Abort)) {
      const conversation = findConversation(world, payload.conversationId);
      if (conversation !== undefined) cmd.add(conversation, Aborted, true);
    }
  }
});

function findConversation(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}
