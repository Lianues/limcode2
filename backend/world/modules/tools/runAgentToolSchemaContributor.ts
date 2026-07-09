import type { WorldReader } from '../../../ecs/types';
import type { ToolSchema } from '../llm/contracts';
import { AgentBlueprintsKey, type BuiltinAgentDefinition, type BuiltinAgentRegistry } from '../agent/blueprints';
import { Agent, AgentKind } from '../agent/components';
import { isTemporaryAgentEntity } from '../agent/identity';
import type { ToolSchemaContributor } from './schemaContributors';
import { DEFAULT_RUN_AGENT_TYPE, RUN_AGENT_TOOL_NAME } from './definitions/runAgent';

export const runAgentToolSchemaContributor: ToolSchemaContributor = {
  key: 'run-agent-blueprint-types',
  reads: { components: [Agent, AgentKind], resources: [AgentBlueprintsKey] },
  augment(tools, context) {
    const blueprints = context.world.tryGetResource(AgentBlueprintsKey);
    if (!blueprints) return tools;
    return tools.map((tool) => tool.name === RUN_AGENT_TOOL_NAME ? withAgentTypeList(tool, context.world, blueprints) : tool);
  }
};

function withAgentTypeList(tool: ToolSchema, world: WorldReader, blueprints: BuiltinAgentRegistry): ToolSchema {
  const typeList = formatAgentTypeList(world, blueprints.agents);
  if (!typeList) return tool;

  const parameters = cloneRecord(tool.parameters);
  const properties = cloneRecord(parameters.properties);
  const agent = cloneRecord(properties.agent);
  const agentProperties = cloneRecord(agent.properties);
  const typeProperty = cloneRecord(agentProperties.type);

  typeProperty.description = [
    `The Agent type/configuration id to use. Defaults to ${DEFAULT_RUN_AGENT_TYPE}. When neither answerBridgeId nor agent.id is provided, the backend creates a temporary mirror dedicated to this child conversation. Prefer answerBridgeId for an existing child conversation; agent.id is only a compatibility selector.`,
    'Currently available Agent types:',
    typeList
  ].join('\n');
  agentProperties.type = typeProperty;
  agent.properties = agentProperties;
  properties.agent = agent;
  parameters.properties = properties;

  return {
    ...tool,
    description: `${tool.description}\n\nPrefer answerBridgeId when continuing an existing child conversation. When creating a new child Agent, choose from these Agent types:\n${typeList}`,
    parameters
  };
}

function formatAgentTypeList(world: WorldReader, agents: Record<string, BuiltinAgentDefinition>): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const entity of world.query(Agent).sort((left, right) => left - right)) {
    if (isTemporaryAgentEntity(world, entity)) continue;
    const agent = world.get(entity, Agent);
    if (!agent?.id || seen.has(agent.id)) continue;
    const kind = world.get(entity, AgentKind)?.kind;
    if (agent.source === 'builtin' && !hasBuiltinAgentDefinition(agents, agent.id, kind)) continue;
    seen.add(agent.id);
    const label = agent.description?.trim() || agent.name.trim();
    const suffix = kind && kind !== agent.id ? ` (kind: ${kind})` : '';
    lines.push(label ? `- ${agent.id}: ${label}${suffix}` : `- ${agent.id}${suffix}`);
  }

  for (const agent of Object.values(agents)) {
    if (seen.has(agent.id) || seen.has(agent.kind)) continue;
    seen.add(agent.id);
    const label = agent.description?.trim();
    lines.push(label ? `- ${agent.id}: ${label}` : `- ${agent.id}`);
  }

  return lines.join('\n');
}

function hasBuiltinAgentDefinition(agents: Record<string, BuiltinAgentDefinition>, id: string, kind: string | undefined): boolean {
  return Object.values(agents).some((definition) => definition.id === id
    || definition.kind === id
    || (!!kind && (definition.id === kind || definition.kind === kind)));
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
