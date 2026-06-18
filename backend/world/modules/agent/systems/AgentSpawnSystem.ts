import { defineQuery, defineSystem } from '../../../../ecs/types';
import { AgentBlueprintsKey } from '../blueprints';
import { AgentFromBlueprintBundle, hasAgentId, hasModeId, spawnAgentFromBlueprint, spawnModeFromDefinition } from '../bundles';
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
    const registry = world.getResource(AgentBlueprintsKey);
    for (const mode of Object.values(registry.modes)) {
      if (!hasModeId(world, mode.id)) spawnModeFromDefinition(cmd, mode);
    }

    for (const entity of world.query(AgentSpawnRequest)) {
      const request = world.get(entity, AgentSpawnRequest);
      if (!request) {
        cmd.despawn(entity);
        continue;
      }

      const definition = registry.agents[request.kind] ?? Object.values(registry.agents).find((candidate) => candidate.kind === request.kind || candidate.id === request.kind);
      if (!definition) {
        console.warn(`[AgentSpawnSystem] Unknown agent blueprint: ${request.kind}`);
        cmd.despawn(entity);
        continue;
      }

      const agentId = request.agentId ?? definition.id;
      const conversationId = request.conversationId ?? `${agentId}-conversation`;
      if (!hasAgentId(world, agentId)) {
        spawnAgentFromBlueprint(cmd, {
          definition,
          agentId,
          agentName: request.agentName,
          conversationId,
          conversationTitle: request.conversationTitle,
          initialMessage: request.initialMessage
        });
      }

      cmd.despawn(entity);
    }
  }
});
