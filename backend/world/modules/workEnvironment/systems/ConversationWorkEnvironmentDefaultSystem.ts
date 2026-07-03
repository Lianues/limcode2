import { defineSystem } from '../../../../ecs/types';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode } from '../../mode/components';
import { ConversationProjectLink, ProjectContext } from '../../project/components';
import { ConversationWorkEnvironmentLink, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../components';
import { WorkEnvironmentBundle, selectConversationWorkEnvironment } from '../bundles';
import { activeWorkEnvironmentForConversation, effectiveWorkEnvironmentPolicyForConversation, linkedWorkEnvironmentForConversation } from '../queries';

export const ConversationWorkEnvironmentDefaultSystem = defineSystem({
  name: 'ConversationWorkEnvironmentDefaultSystem',
  shouldRun({ world }) {
    if (world.query(WorkEnvironment).every((entity) => world.get(entity, WorkEnvironment)?.available !== true)) return false;
    return world.query(Conversation).some((conversation) => {
      if (effectiveWorkEnvironmentPolicyForConversation(world, conversation).policy?.enabled !== true) return false;
      const linked = linkedWorkEnvironmentForConversation(world, conversation);
      const resolved = activeWorkEnvironmentForConversation(world, conversation);
      return !!resolved && linked?.entity !== resolved.entity;
    });
  },
  access: {
    reads: { components: [Conversation, Agent, AgentRun, Mode, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink, ConversationWorkEnvironmentLink, ConversationProjectLink, ProjectContext] },
    bundles: [WorkEnvironmentBundle]
  },
  run({ world, cmd }) {
    for (const conversation of world.query(Conversation)) {
      if (effectiveWorkEnvironmentPolicyForConversation(world, conversation).policy?.enabled !== true) continue;
      const linked = linkedWorkEnvironmentForConversation(world, conversation);
      const resolved = activeWorkEnvironmentForConversation(world, conversation);
      if (!resolved || linked?.entity === resolved.entity) continue;
      selectConversationWorkEnvironment(world, cmd, conversation, resolved.entity);
    }
  }
});
