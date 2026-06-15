import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Conversation } from '../../chat/components';
import { ConversationModeSelection, Mode } from '../components';
import { GLOBAL_MODE_SELECTION_ID_PREFIX, MODE_SELECTION_ID_PREFIX } from '../bundles';
import { ModeEventType } from '../events';

export const ConversationModeSelectionSystem = defineSystem({
  name: 'ConversationModeSelectionSystem',
  shouldRun(ctx) {
    return readEvents(ctx, ModeEventType.ConversationSelect).length > 0;
  },
  access: {
    reads: { components: [Conversation, ConversationModeSelection, Mode] },
    writes: { components: [ConversationModeSelection], mutationMode: 'update' },
    events: { read: [ModeEventType.ConversationSelect] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ModeEventType.ConversationSelect)) {
      const conversation = findConversationById(world, payload.conversationId);
      if (conversation === undefined) continue;
      const mode = payload.scopeKind === 'mode' ? findModeById(world, payload.modeId) : undefined;
      if (payload.scopeKind === 'mode' && mode === undefined) continue;

      const now = Date.now();
      let selected: Entity | undefined;
      for (const entity of world.query(ConversationModeSelection)) {
        const current = world.get(entity, ConversationModeSelection);
        if (!current || current.conversation !== conversation || current.role !== 'active') continue;
        if (selected === undefined) selected = entity;
        else cmd.despawn(entity);
      }

      const entity = selected ?? cmd.spawn();
      const previous = selected !== undefined ? world.get(selected, ConversationModeSelection) : undefined;
      cmd.add(entity, ConversationModeSelection, {
        id: payload.scopeKind === 'global'
          ? `${GLOBAL_MODE_SELECTION_ID_PREFIX}${payload.conversationId}`
          : `${MODE_SELECTION_ID_PREFIX}${payload.conversationId}:${payload.modeId}`,
        conversation,
        scopeKind: payload.scopeKind,
        ...(payload.scopeKind === 'mode' && mode !== undefined ? { mode } : {}),
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

function findModeById(world: WorldReader, modeId: string): Entity | undefined {
  return world.query(Mode).find((entity) => world.get(entity, Mode)?.id === modeId);
}
