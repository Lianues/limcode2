import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { ToolPolicyScopeLink } from '../../tools/components';
import { ConversationWorkflowSelection, Workflow, ModelProfileScopeLink, SystemPromptScopeLink } from '../components';
import { WorkflowEventType } from '../events';

export const WorkflowCrudSystem = defineSystem({
  name: 'WorkflowCrudSystem',
  shouldRun(ctx) {
    return readEvents(ctx, WorkflowEventType.Create).length > 0
      || readEvents(ctx, WorkflowEventType.Update).length > 0
      || readEvents(ctx, WorkflowEventType.Delete).length > 0;
  },
  access: {
    reads: { components: [Workflow, ConversationWorkflowSelection, ToolPolicyScopeLink, SystemPromptScopeLink, ModelProfileScopeLink] },
    writes: { components: [Workflow, ConversationWorkflowSelection, ToolPolicyScopeLink, SystemPromptScopeLink, ModelProfileScopeLink], mutationMode: 'update' },
    events: { read: [WorkflowEventType.Create, WorkflowEventType.Update, WorkflowEventType.Delete] }
  },
  run(ctx) {
    const { world, cmd } = ctx;

    for (const payload of readEvents(ctx, WorkflowEventType.Create)) {
      const name = normalizeName(payload.name, '新工作流');
      const now = Date.now();
      const entity = cmd.spawn();
      const id = `workflow:${createMessageId()}`;
      cmd.add(entity, Workflow, {
        id,
        name,
        ...(normalizeDescription(payload.description) ? { description: normalizeDescription(payload.description) } : {}),
        source: 'user',
        icon: 'list-details',
        createdAt: now,
        updatedAt: now
      });
    }

    for (const payload of readEvents(ctx, WorkflowEventType.Update)) {
      const target = findWorkflowById(world, payload.workflowId);
      if (target === undefined) continue;
      const current = world.get(target, Workflow);
      if (!current) continue;
      const nextName = payload.name === undefined ? current.name : normalizeName(payload.name, current.name);
      const nextDescription = payload.description === undefined ? current.description : normalizeDescription(payload.description);
      const nextIcon = payload.icon === undefined ? current.icon : payload.icon;
      const next = { ...current, name: nextName, icon: nextIcon, updatedAt: Date.now() };
      if (nextDescription) next.description = nextDescription;
      else delete next.description;
      cmd.add(target, Workflow, next);
    }

    for (const payload of readEvents(ctx, WorkflowEventType.Delete)) {
      const target = findWorkflowById(world, payload.workflowId);
      if (target === undefined) continue;
      const current = world.get(target, Workflow);
      if (!current || current.source === 'builtin') continue;
      for (const entity of relatedSelectionEntities(world, target)) cmd.despawn(entity);
      for (const entity of relatedToolPolicyScopeLinkEntities(world, current.id, target)) cmd.despawn(entity);
      for (const entity of relatedSystemPromptScopeLinkEntities(world, current.id, target)) cmd.despawn(entity);
      for (const entity of relatedModelProfileScopeLinkEntities(world, current.id, target)) cmd.despawn(entity);
      cmd.despawn(target);
    }
  }
});

function findWorkflowById(world: WorldReader, workflowId: string): Entity | undefined {
  return world.query(Workflow).find((entity) => world.get(entity, Workflow)?.id === workflowId);
}

function relatedSelectionEntities(world: WorldReader, workflow: Entity): Entity[] {
  return world.query(ConversationWorkflowSelection).filter((entity) => world.get(entity, ConversationWorkflowSelection)?.workflow === workflow);
}

function relatedToolPolicyScopeLinkEntities(world: WorldReader, workflowId: string, workflow: Entity): Entity[] {
  return world.query(ToolPolicyScopeLink).filter((entity) => {
    const link = world.get(entity, ToolPolicyScopeLink);
    return !!link && link.scopeKind === 'workflow' && (link.workflow === workflow || link.scopeId === workflowId);
  });
}

function relatedSystemPromptScopeLinkEntities(world: WorldReader, workflowId: string, workflow: Entity): Entity[] {
  return world.query(SystemPromptScopeLink).filter((entity) => {
    const link = world.get(entity, SystemPromptScopeLink);
    return !!link && link.scopeKind === 'workflow' && (link.workflow === workflow || link.scopeId === workflowId);
  });
}

function relatedModelProfileScopeLinkEntities(world: WorldReader, workflowId: string, workflow: Entity): Entity[] {
  return world.query(ModelProfileScopeLink).filter((entity) => {
    const link = world.get(entity, ModelProfileScopeLink);
    return !!link && link.scopeKind === 'workflow' && (link.workflow === workflow || link.scopeId === workflowId);
  });
}

function normalizeName(value: string | undefined, fallback: string): string {
  const text = value?.trim().replace(/\s+/g, ' ');
  return text || fallback;
}

function normalizeDescription(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}
