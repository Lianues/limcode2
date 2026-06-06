import { defineQuery, defineSystem } from '../../../../ecs/types';
import { AgentBlueprintsKey } from '../blueprints';
import { AgentFromBlueprintBundle, spawnAgentFromBlueprint } from '../bundles';
import { AgentSpawnRequest } from '../requests';

const SpawnRequestsQuery = defineQuery({
  name: 'SpawnRequests',
  all: [AgentSpawnRequest],
  read: [AgentSpawnRequest],
  remove: [AgentSpawnRequest],
  mutationMode: 'consume',
  role: 'work'
});

export const AgentSpawnSystem = defineSystem({
  name: 'AgentSpawnSystem',
  shouldRun({ world }) {
    return world.query(AgentSpawnRequest).length > 0;
  },
  access: {
    queries: [SpawnRequestsQuery],
    resources: { read: [AgentBlueprintsKey] },
    bundles: [AgentFromBlueprintBundle]
  },
  run({ world, cmd }) {
    for (const entity of world.query(AgentSpawnRequest)) {
      const request = world.get(entity, AgentSpawnRequest);
      if (!request) {
        cmd.despawn(entity);
        continue;
      }

      const blueprints = world.getResource(AgentBlueprintsKey);
      const blueprint = blueprints[request.kind];
      if (!blueprint) {
        console.warn(`[AgentSpawnSystem] Unknown agent blueprint: ${request.kind}`);
        cmd.despawn(entity);
        continue;
      }

      const agentId = request.agentId ?? `${request.kind}-${entity}`;
      const conversationId = request.conversationId ?? `${agentId}-conversation`;
      spawnAgentFromBlueprint(cmd, {
        blueprint,
        agentId,
        agentName: request.agentName,
        conversationId,
        conversationTitle: request.conversationTitle,
        initialMessage: request.initialMessage
      });

      cmd.despawn(entity);
    }
  }
});
