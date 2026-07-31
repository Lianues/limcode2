import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentBlueprintsKey, DEFAULT_INTEGRATED_SYSTEM_PROMPT } from '../blueprints';
import {
  AgentFromBlueprintBundle,
  hasAgentId,
  hasWorkflowId,
  linkSystemPromptToScope,
  spawnAgentFromBlueprint,
  spawnAgentProfileFromBlueprint,
  spawnConversationForAgent,
  spawnWorkflowFromDefinition,
  spawnSystemPrompt
} from '../bundles';
import { Agent } from '../components';
import { Conversation } from '../../chat/components';
import { SystemPrompt, SystemPromptScopeLink, type SystemPromptScopeLinkData } from '../../workflow/components';
import { AgentSpawnRequest } from '../requests';
import type { ConfigScopeKind } from '../../../../../shared/protocol';

const DEFAULT_GLOBAL_SYSTEM_PROMPT_ID = 'system-prompt:global:integrated';
const DEFAULT_GLOBAL_SYSTEM_PROMPT_NAME = 'Integrated Global System Prompt';

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
    if (!registry) return false;
    return world.query(AgentSpawnRequest).length > 0
      || !hasActiveSystemPromptForScope(world, 'global')
      || Object.values(registry.workflows).some((workflow) => !hasWorkflowId(world, workflow.id))
      || Object.values(registry.agents).some((agent) => !hasAgentId(world, agent.id));
  },
  access: {
    queries: [SpawnRequestsQuery],
    reads: { components: [Agent, Conversation, SystemPrompt, SystemPromptScopeLink] },
    resources: { read: [AgentBlueprintsKey] },
    bundles: [AgentFromBlueprintBundle]
  },
  run({ world, cmd }) {
    const registry = world.getResource(AgentBlueprintsKey);
    ensureIntegratedGlobalSystemPrompt(world, cmd);

    for (const workflow of Object.values(registry.workflows)) {
      if (!hasWorkflowId(world, workflow.id)) spawnWorkflowFromDefinition(cmd, workflow);
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
      const existingAgent = world.query(Agent).find((candidate) => world.get(candidate, Agent)?.id === agentId);
      if (existingAgent === undefined) {
        spawnAgentFromBlueprint(cmd, {
          definition,
          agentId,
          agentName: request.agentName,
          conversationId,
          conversationTitle: request.conversationTitle,
          initialMessage: request.initialMessage
        });
      } else if (!world.query(Conversation).some((candidate) => world.get(candidate, Conversation)?.id === conversationId)) {
        // Agent 可能在请求排队期间由 startup hydration 恢复。复用已有 Agent，
        // 但仍必须完成这次请求所拥有的 Conversation/Link/Selection 创建。
        spawnConversationForAgent(cmd, {
          agent: existingAgent,
          agentId,
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

function ensureIntegratedGlobalSystemPrompt(world: WorldReader, cmd: CommandSink): void {
  if (hasActiveSystemPromptForScope(world, 'global')) return;
  const prompt = spawnSystemPrompt(cmd, {
    id: DEFAULT_GLOBAL_SYSTEM_PROMPT_ID,
    name: DEFAULT_GLOBAL_SYSTEM_PROMPT_NAME,
    text: DEFAULT_INTEGRATED_SYSTEM_PROMPT
  });
  linkSystemPromptToScope(cmd, { scopeKind: 'global', systemPrompt: prompt });
}

function hasActiveSystemPromptForScope(world: WorldReader, scopeKind: ConfigScopeKind, scopeId?: string): boolean {
  return scopedPromptLinks(world, scopeKind, scopeId).some(({ link }) => !!world.get(link.systemPrompt, SystemPrompt)?.text.trim());
}

function scopedPromptLinks(world: WorldReader, scopeKind: ConfigScopeKind, scopeId: string | undefined): Array<{ entity: Entity; link: SystemPromptScopeLinkData }> {
  const links: Array<{ entity: Entity; link: SystemPromptScopeLinkData }> = [];
  for (const entity of world.query(SystemPromptScopeLink)) {
    const link = world.get(entity, SystemPromptScopeLink);
    if (!link || link.role !== 'active' || link.scopeKind !== scopeKind) continue;
    if (scopeKind === 'global') {
      links.push({ entity, link });
      continue;
    }
    if (link.scopeId === scopeId) links.push({ entity, link });
  }
  return links;
}
