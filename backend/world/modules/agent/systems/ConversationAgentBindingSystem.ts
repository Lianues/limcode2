import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { Conversation } from '../../chat/components';
import { Agent, AgentConversationLink, ConversationAgentSelection } from '../components';
import {
  ConversationAgentBindingBundle,
  ensureVisibleConversationAgentBinding
} from '../bundles';

const DEFAULT_AGENT_ID = 'main';

export const ConversationAgentBindingSystem = defineSystem({
  name: 'ConversationAgentBindingSystem',
  shouldRun({ world }) {
    const defaultAgent = world.query(Agent).find((entity) => world.get(entity, Agent)?.id === DEFAULT_AGENT_ID);
    if (defaultAgent === undefined) return false;
    return world.query(Conversation).some((conversation) =>
      visibleConversationNeedsAgentBinding(world, conversation)
    );
  },
  access: {
    reads: { components: [Agent, Conversation, AgentConversationLink, ConversationAgentSelection] },
    bundles: [ConversationAgentBindingBundle]
  },
  run({ world, cmd }) {
    const defaultAgent = world.query(Agent).find((entity) => world.get(entity, Agent)?.id === DEFAULT_AGENT_ID);
    if (defaultAgent === undefined) return;
    for (const conversation of world.query(Conversation)) {
      ensureVisibleConversationAgentBinding(world, cmd, { conversation, defaultAgent });
    }
  }
});

function visibleConversationNeedsAgentBinding(
  world: WorldReader,
  conversation: Entity
): boolean {
  const record = world.get(conversation, Conversation);
  if (!record || (record.visibility ?? 'visible') !== 'visible') return false;

  const selection = world.query(ConversationAgentSelection)
    .map((entity) => world.get(entity, ConversationAgentSelection))
    .find((candidate) =>
      candidate?.role === 'active'
      && candidate.conversation === conversation
      && !!world.get(candidate.agent, Agent)
    );
  if (selection) {
    return !world.query(AgentConversationLink).some((entity) => {
      const link = world.get(entity, AgentConversationLink);
      return link?.conversation === conversation && link.agent === selection.agent;
    });
  }
  return true;
}
