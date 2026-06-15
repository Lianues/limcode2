import { defineBundle, type CommandSink, type Entity, type World } from '../../../ecs/types';
import { ConversationModeSelection, Mode } from './components';

export const BUILTIN_PLAN_MODE_ID = 'builtin:plan';
export const GLOBAL_MODE_SELECTION_ID_PREFIX = 'conversation-mode:global:';
export const MODE_SELECTION_ID_PREFIX = 'conversation-mode:mode:';

export const ModeBundle = defineBundle({
  name: 'ModeBundle',
  writes: [Mode, ConversationModeSelection],
  mutationMode: 'create',
  spawns: true
});

export function ensureBuiltinPlanMode(world: World): Entity {
  const existing = findModeById(world, BUILTIN_PLAN_MODE_ID);
  const now = Date.now();
  if (existing !== undefined) {
    const current = world.get(existing, Mode)!;
    world.add(existing, Mode, {
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
  world.add(entity, Mode, {
    id: BUILTIN_PLAN_MODE_ID,
    name: 'Plan',
    description: '先规划、分析和拆解任务，再执行后续实现。',
    source: 'builtin',
    icon: 'list-details',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function selectGlobalModeForConversation(cmd: CommandSink, conversation: Entity, conversationId: string): Entity {
  const now = Date.now();
  const entity = cmd.spawn();
  cmd.add(entity, ConversationModeSelection, {
    id: `${GLOBAL_MODE_SELECTION_ID_PREFIX}${conversationId}`,
    conversation,
    scopeKind: 'global',
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function upsertGlobalModeSelection(world: World, conversation: Entity, conversationId: string): Entity {
  return upsertConversationModeSelection(world, conversation, conversationId, { scopeKind: 'global' });
}

export function upsertModeSelection(world: World, conversation: Entity, conversationId: string, mode: Entity, modeId: string): Entity {
  return upsertConversationModeSelection(world, conversation, conversationId, { scopeKind: 'mode', mode, modeId });
}

function upsertConversationModeSelection(
  world: World,
  conversation: Entity,
  conversationId: string,
  input: { scopeKind: 'global' } | { scopeKind: 'mode'; mode: Entity; modeId: string }
): Entity {
  const now = Date.now();
  let selected: Entity | undefined;
  for (const entity of world.query(ConversationModeSelection)) {
    const current = world.get(entity, ConversationModeSelection);
    if (!current || current.conversation !== conversation || current.role !== 'active') continue;
    if (selected === undefined) selected = entity;
    else world.despawn(entity);
  }

  const entity = selected ?? world.spawn();
  const previous = selected !== undefined ? world.get(selected, ConversationModeSelection) : undefined;
  world.add(entity, ConversationModeSelection, {
    id: input.scopeKind === 'global'
      ? `${GLOBAL_MODE_SELECTION_ID_PREFIX}${conversationId}`
      : `${MODE_SELECTION_ID_PREFIX}${conversationId}:${input.modeId}`,
    conversation,
    scopeKind: input.scopeKind,
    ...(input.scopeKind === 'mode' ? { mode: input.mode } : {}),
    role: 'active',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  });
  return entity;
}

export function findModeById(world: World, modeId: string): Entity | undefined {
  return world.query(Mode).find((entity) => world.get(entity, Mode)?.id === modeId);
}
