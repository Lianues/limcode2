import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Conversation } from '../../chat/components';
import { ConversationWorkflowSelection, Workflow } from '../components';
import { DEFAULT_WORKFLOW_SELECTION_ID_PREFIX, WORKFLOW_SELECTION_ID_PREFIX } from '../bundles';
import { WorkflowEventType } from '../events';

export const ConversationWorkflowSelectionSystem = defineSystem({
  name: 'ConversationWorkflowSelectionSystem',
  shouldRun(ctx) {
    return readEvents(ctx, WorkflowEventType.ConversationSelect).length > 0;
  },
  access: {
    reads: { components: [Conversation, ConversationWorkflowSelection, Workflow] },
    writes: { components: [ConversationWorkflowSelection], mutationMode: 'update' },
    events: { read: [WorkflowEventType.ConversationSelect] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, WorkflowEventType.ConversationSelect)) {
      const conversation = findConversationById(world, payload.conversationId);
      if (conversation === undefined) continue;
      const workflow = payload.scopeKind === 'workflow' ? findWorkflowById(world, payload.workflowId) : undefined;
      if (payload.scopeKind === 'workflow' && workflow === undefined) continue;

      const now = Date.now();
      let selected: Entity | undefined;
      for (const entity of world.query(ConversationWorkflowSelection)) {
        const current = world.get(entity, ConversationWorkflowSelection);
        if (!current || current.conversation !== conversation || current.role !== 'active') continue;
        if (selected === undefined) selected = entity;
        else cmd.despawn(entity);
      }

      const entity = selected ?? cmd.spawn();
      const previous = selected !== undefined ? world.get(selected, ConversationWorkflowSelection) : undefined;
      cmd.add(entity, ConversationWorkflowSelection, {
        id: payload.scopeKind === 'global'
          ? `${DEFAULT_WORKFLOW_SELECTION_ID_PREFIX}${payload.conversationId}`
          : `${WORKFLOW_SELECTION_ID_PREFIX}${payload.conversationId}:${payload.workflowId}`,
        conversation,
        scopeKind: payload.scopeKind,
        ...(payload.scopeKind === 'workflow' && workflow !== undefined ? { workflow } : {}),
        role: 'active',
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      });
    }
  }
});

function findConversationById(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

function findWorkflowById(world: WorldReader, workflowId: string): Entity | undefined {
  return world.query(Workflow).find((entity) => world.get(entity, Workflow)?.id === workflowId);
}
