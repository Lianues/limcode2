import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { ChatEventType } from '../events';
import { readEvents } from '../../../events';
import { Aborted, NeedsResponse, Session } from '../components';
import { spawnUserMessage, UserMessageBundle } from '../bundles';

const SessionsByIdQuery = defineQuery({
  name: 'SessionsById',
  all: [Session],
  read: [Session],
  role: 'lookup'
});

export const InputSystem = defineSystem({
  name: 'InputSystem',
  worker: { modulePath: '../world/modules/chat/systems/InputSystem', exportName: 'InputSystem' },
  access: {
    queries: [SessionsByIdQuery],
    events: { read: [ChatEventType.Send, ChatEventType.Abort] },
    writes: { components: [NeedsResponse, Aborted] },
    bundles: [UserMessageBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ChatEventType.Send)) {
      const session = findSession(world, payload.sessionId);
      if (session === undefined) continue;
      spawnUserMessage(cmd, session, payload.text);
      cmd.add(session, NeedsResponse, { since: Date.now() });
    }

    for (const payload of readEvents(ctx, ChatEventType.Abort)) {
      const session = findSession(world, payload.sessionId);
      if (session !== undefined) cmd.add(session, Aborted, true);
    }
  }
});

function findSession(world: WorldReader, sessionId: string): Entity | undefined {
  return world.query(Session).find((entity) => world.get(entity, Session)?.id === sessionId);
}
