import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { ToolPolicyScopeLink } from '../../tools/components';
import { ConversationModeSelection, Mode, ModelProfileScopeLink, SystemPromptScopeLink } from '../components';
import { ModeEventType } from '../events';

export const ModeCrudSystem = defineSystem({
  name: 'ModeCrudSystem',
  shouldRun(ctx) {
    return readEvents(ctx, ModeEventType.Create).length > 0
      || readEvents(ctx, ModeEventType.Update).length > 0
      || readEvents(ctx, ModeEventType.Delete).length > 0;
  },
  access: {
    reads: { components: [Mode, ConversationModeSelection, ToolPolicyScopeLink, SystemPromptScopeLink, ModelProfileScopeLink] },
    writes: { components: [Mode, ConversationModeSelection, ToolPolicyScopeLink, SystemPromptScopeLink, ModelProfileScopeLink], mutationMode: 'update' },
    events: { read: [ModeEventType.Create, ModeEventType.Update, ModeEventType.Delete] }
  },
  run(ctx) {
    const { world, cmd } = ctx;

    for (const payload of readEvents(ctx, ModeEventType.Create)) {
      const name = normalizeName(payload.name, '新工作流');
      const now = Date.now();
      const entity = cmd.spawn();
      const id = `mode:${createMessageId()}`;
      cmd.add(entity, Mode, {
        id,
        name,
        ...(normalizeDescription(payload.description) ? { description: normalizeDescription(payload.description) } : {}),
        source: 'user',
        icon: 'list-details',
        createdAt: now,
        updatedAt: now
      });
    }

    for (const payload of readEvents(ctx, ModeEventType.Update)) {
      const target = findModeById(world, payload.modeId);
      if (target === undefined) continue;
      const current = world.get(target, Mode);
      if (!current) continue;
      const nextName = payload.name === undefined ? current.name : normalizeName(payload.name, current.name);
      const nextDescription = payload.description === undefined ? current.description : normalizeDescription(payload.description);
      const next = { ...current, name: nextName, updatedAt: Date.now() };
      if (nextDescription) next.description = nextDescription;
      else delete next.description;
      cmd.add(target, Mode, next);
    }

    for (const payload of readEvents(ctx, ModeEventType.Delete)) {
      const target = findModeById(world, payload.modeId);
      if (target === undefined) continue;
      const current = world.get(target, Mode);
      if (!current || current.source === 'builtin') continue;
      for (const entity of relatedSelectionEntities(world, target)) cmd.despawn(entity);
      for (const entity of relatedToolPolicyScopeLinkEntities(world, current.id, target)) cmd.despawn(entity);
      for (const entity of relatedSystemPromptScopeLinkEntities(world, current.id, target)) cmd.despawn(entity);
      for (const entity of relatedModelProfileScopeLinkEntities(world, current.id, target)) cmd.despawn(entity);
      cmd.despawn(target);
    }
  }
});

function findModeById(world: WorldReader, modeId: string): Entity | undefined {
  return world.query(Mode).find((entity) => world.get(entity, Mode)?.id === modeId);
}

function relatedSelectionEntities(world: WorldReader, mode: Entity): Entity[] {
  return world.query(ConversationModeSelection).filter((entity) => world.get(entity, ConversationModeSelection)?.mode === mode);
}

function relatedToolPolicyScopeLinkEntities(world: WorldReader, modeId: string, mode: Entity): Entity[] {
  return world.query(ToolPolicyScopeLink).filter((entity) => {
    const link = world.get(entity, ToolPolicyScopeLink);
    return !!link && link.scopeKind === 'mode' && (link.mode === mode || link.scopeId === modeId);
  });
}

function relatedSystemPromptScopeLinkEntities(world: WorldReader, modeId: string, mode: Entity): Entity[] {
  return world.query(SystemPromptScopeLink).filter((entity) => {
    const link = world.get(entity, SystemPromptScopeLink);
    return !!link && link.scopeKind === 'mode' && (link.mode === mode || link.scopeId === modeId);
  });
}

function relatedModelProfileScopeLinkEntities(world: WorldReader, modeId: string, mode: Entity): Entity[] {
  return world.query(ModelProfileScopeLink).filter((entity) => {
    const link = world.get(entity, ModelProfileScopeLink);
    return !!link && link.scopeKind === 'mode' && (link.mode === mode || link.scopeId === modeId);
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
