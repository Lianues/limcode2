import { defineBundle, type CommandSink, type Entity, type World } from '../../../ecs/types';
import { ConversationWorkflowSelection, Workflow } from './components';

export const BUILTIN_PLAN_WORKFLOW_ID = 'builtin:plan';
export const DEFAULT_WORKFLOW_SELECTION_ID_PREFIX = 'conversation-workflow:global:';
export const WORKFLOW_SELECTION_ID_PREFIX = 'conversation-workflow:workflow:';

export const WorkflowBundle = defineBundle({
  name: 'WorkflowBundle',
  writes: [Workflow, ConversationWorkflowSelection],
  mutationMode: 'create',
  spawns: true
});

export function ensureBuiltinPlanWorkflow(world: World): Entity {
  const existing = findWorkflowById(world, BUILTIN_PLAN_WORKFLOW_ID);
  const now = Date.now();
  if (existing !== undefined) {
    const current = world.get(existing, Workflow)!;
    world.add(existing, Workflow, {
      ...current,
      name: 'Plan',
      description: current.description || '先规划、分析和拆解任务，再执行后续实现。',
      source: 'builtin',
      icon: 'list-details',
      updatedAt: current.updatedAt || now
    });
    return existing;
  }

  const entity = world.spawn();
  world.add(entity, Workflow, {
    id: BUILTIN_PLAN_WORKFLOW_ID,
    name: 'Plan',
    description: '先规划、分析和拆解任务，再执行后续实现。',
    source: 'builtin',
    icon: 'list-details',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function selectDefaultWorkflowForConversation(cmd: CommandSink, conversation: Entity, conversationId: string): Entity {
  const now = Date.now();
  const entity = cmd.spawn();
  cmd.add(entity, ConversationWorkflowSelection, {
    id: `${DEFAULT_WORKFLOW_SELECTION_ID_PREFIX}${conversationId}`,
    conversation,
    scopeKind: 'global',
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function upsertDefaultWorkflowSelection(world: World, conversation: Entity, conversationId: string): Entity {
  return upsertConversationWorkflowSelection(world, conversation, conversationId, { scopeKind: 'global' });
}

export function upsertWorkflowSelection(world: World, conversation: Entity, conversationId: string, workflow: Entity, workflowId: string): Entity {
  return upsertConversationWorkflowSelection(world, conversation, conversationId, { scopeKind: 'workflow', workflow, workflowId });
}

function upsertConversationWorkflowSelection(
  world: World,
  conversation: Entity,
  conversationId: string,
  input: { scopeKind: 'global' } | { scopeKind: 'workflow'; workflow: Entity; workflowId: string }
): Entity {
  const now = Date.now();
  let selected: Entity | undefined;
  for (const entity of world.query(ConversationWorkflowSelection)) {
    const current = world.get(entity, ConversationWorkflowSelection);
    if (!current || current.conversation !== conversation || current.role !== 'active') continue;
    if (selected === undefined) selected = entity;
    else world.despawn(entity);
  }

  const entity = selected ?? world.spawn();
  const previous = selected !== undefined ? world.get(selected, ConversationWorkflowSelection) : undefined;
  world.add(entity, ConversationWorkflowSelection, {
    id: input.scopeKind === 'global'
      ? `${DEFAULT_WORKFLOW_SELECTION_ID_PREFIX}${conversationId}`
      : `${WORKFLOW_SELECTION_ID_PREFIX}${conversationId}:${input.workflowId}`,
    conversation,
    scopeKind: input.scopeKind,
    ...(input.scopeKind === 'workflow' ? { workflow: input.workflow } : {}),
    role: 'active',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  });
  return entity;
}

export function findWorkflowById(world: World, workflowId: string): Entity | undefined {
  return world.query(Workflow).find((entity) => world.get(entity, Workflow)?.id === workflowId);
}
