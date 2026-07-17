import { defineSystem } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Workflow } from '../../workflow/components';
import { WorkEnvironmentEventType } from '../events';
import { ConversationWorkEnvironmentLink, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../components';
import { WorkEnvironmentBundle, findWorkEnvironmentById, selectConversationWorkEnvironment } from '../bundles';
import { allowedWorkEnvironmentsForConversation } from '../queries';

export const ConversationWorkEnvironmentSelectionSystem = defineSystem({
  name: 'ConversationWorkEnvironmentSelectionSystem',
  shouldRun(ctx) {
    return readEvents(ctx, WorkEnvironmentEventType.ConversationSelectRequested).length > 0;
  },
  access: {
    reads: { components: [Conversation, Agent, AgentRun, Workflow, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink, ConversationWorkEnvironmentLink] },
    bundles: [WorkEnvironmentBundle],
    events: { read: [WorkEnvironmentEventType.ConversationSelectRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, WorkEnvironmentEventType.ConversationSelectRequested)) {
      const conversation = world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === payload.conversationId);
      const workEnvironment = findWorkEnvironmentById(world, payload.workEnvironmentId);
      const data = workEnvironment !== undefined ? world.get(workEnvironment, WorkEnvironment) : undefined;
      if (conversation === undefined || workEnvironment === undefined || data?.available !== true) continue;
      const allowed = new Set(allowedWorkEnvironmentsForConversation(world, conversation).map((item) => item.entity));
      if (!allowed.has(workEnvironment)) continue;
      selectConversationWorkEnvironment(world, cmd, conversation, workEnvironment);
    }
  }
});
