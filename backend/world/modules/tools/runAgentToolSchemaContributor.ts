import type { ToolSchema } from '../llm/contracts';
import { AgentBlueprintsKey, type BuiltinAgentDefinition, type BuiltinAgentRegistry } from '../agent/blueprints';
import type { ToolSchemaContributor } from './schemaContributors';
import { RUN_AGENT_TOOL_NAME } from './definitions/runAgent';

export const runAgentToolSchemaContributor: ToolSchemaContributor = {
  key: 'run-agent-blueprint-types',
  reads: { resources: [AgentBlueprintsKey] },
  augment(tools, context) {
    const blueprints = context.world.tryGetResource(AgentBlueprintsKey);
    if (!blueprints) return tools;
    return tools.map((tool) => tool.name === RUN_AGENT_TOOL_NAME ? withAgentTypeList(tool, blueprints) : tool);
  }
};

function withAgentTypeList(tool: ToolSchema, blueprints: BuiltinAgentRegistry): ToolSchema {
  const typeList = formatAgentTypeList(blueprints.agents);
  if (!typeList) return tool;

  const parameters = cloneRecord(tool.parameters);
  const properties = cloneRecord(parameters.properties);
  const agent = cloneRecord(properties.agent);
  const agentProperties = cloneRecord(agent.properties);
  const typeProperty = cloneRecord(agentProperties.type);

  typeProperty.description = [
    '未传 agent.id 时使用的 Agent 蓝图 kind。默认 general-purpose。',
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

function formatAgentTypeList(agents: Record<string, BuiltinAgentDefinition>): string {
  return Object.values(agents)
    .map((agent) => {
      const label = agent.description?.trim();
      return label ? `- ${agent.kind}: ${label}` : `- ${agent.kind}`;
    })
    .join('\n');
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
