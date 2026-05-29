import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { LlmRequest, NeedsResponse, Session } from '../components';
import { AssistantMessageBundle, LlmRequestBundle, spawnAssistantMessage, spawnLlmRequest } from '../bundles';

const SessionsNeedingResponseQuery = defineQuery({
  name: 'SessionsNeedingResponse',
  all: [Session, NeedsResponse],
  read: [Session, NeedsResponse],
  remove: [NeedsResponse],
  mutationMode: 'consume',
  role: 'work'
});

const ActiveLlmRequestsQuery = defineQuery({
  name: 'ActiveLlmRequests',
  all: [LlmRequest],
  read: [LlmRequest],
  role: 'lookup'
});

export const ContextAssemblySystem = defineSystem({
  name: 'ContextAssemblySystem',
  worker: { modulePath: '../world/modules/chat/systems/ContextAssemblySystem', exportName: 'ContextAssemblySystem' },
  access: {
    queries: [SessionsNeedingResponseQuery, ActiveLlmRequestsQuery],
    bundles: [AssistantMessageBundle, LlmRequestBundle]
  },
  run({ world, cmd }) {
    for (const session of world.query(Session, NeedsResponse)) {
      if (hasActiveRequest(world, session)) {
        cmd.remove(session, NeedsResponse);
        continue;
      }
      const assistant = spawnAssistantMessage(cmd, session);
      spawnLlmRequest(cmd, { session, assistant });
      cmd.remove(session, NeedsResponse);
    }
  }
});

function hasActiveRequest(world: WorldReader, session: Entity): boolean {
  return world.query(LlmRequest).some((request) => world.get(request, LlmRequest)?.sessionEntity === session);
}
