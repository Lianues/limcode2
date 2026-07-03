import type { WorldReader } from '../../../ecs/types';
import type { ToolSchema } from '../llm/contracts';
import { AgentBlueprintsKey, type BuiltinAgentDefinition, type BuiltinAgentRegistry } from '../agent/blueprints';
import { Agent, AgentKind } from '../agent/components';
import { isTemporaryAgentEntity } from '../agent/identity';
import type { ToolSchemaContributor } from './schemaContributors';
import { RUN_AGENT_TOOL_NAME } from './definitions/runAgent';

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
    '要使用的 Agent 类型/配置 id。默认 general-purpose；未传 agent.id 时后端会创建只属于本次子对话的临时镜像。agent.id 仅用于复用 run_agent 返回的临时镜像并追加任务。',
    '当前可用 Agent 类型：',
    typeList
  ].join('\n');
  agentProperties.type = typeProperty;
  agent.properties = agentProperties;
  properties.agent = agent;
  parameters.properties = properties;

  return {
    ...tool,
    description: `${tool.description}\n\n当前可用 Agent 类型：\n${typeList}`,
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
    seen.add(agent.id);
    const kind = world.get(entity, AgentKind)?.kind;
    const label = agent.description?.trim() || agent.name.trim();
    const suffix = kind && kind !== agent.id ? `（kind: ${kind}）` : '';
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

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
