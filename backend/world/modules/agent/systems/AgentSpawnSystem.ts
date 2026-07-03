import { defineQuery, defineSystem } from '../../../../ecs/types';
import { AgentBlueprintsKey } from '../blueprints';
import { AgentFromBlueprintBundle, hasAgentId, hasModeId, spawnAgentFromBlueprint, spawnAgentProfileFromBlueprint, spawnModeFromDefinition } from '../bundles';
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
    const registry = world.tryGetResource(AgentBlueprintsKey);
    return world.query(AgentSpawnRequest).length > 0
      || !!registry && Object.values(registry.modes).some((mode) => !hasModeId(world, mode.id))
      || !!registry && Object.values(registry.agents).some((agent) => !hasAgentId(world, agent.id));
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

    const requests = world.query(AgentSpawnRequest);
    for (const entity of requests) {
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

    if (requests.length > 0) return;

    for (const definition of Object.values(registry.agents)) {
      if (!hasAgentId(world, definition.id)) spawnAgentProfileFromBlueprint(cmd, { definition, agentId: definition.id });
    }
  }
});
