import { SWITCH_WORK_ENVIRONMENT_TOOL_NAME } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import type { ToolSchemaContributor } from '../tools/schemaContributors';
import { Agent } from '../agent/components';
import { AgentRun, AgentRunTargetLink, RunModeLink } from '../agentRun/components';
import { AgentModeLink, ConversationModeSelection, Mode } from '../mode/components';
import { Conversation } from '../chat/components';
import { ConversationProjectLink, ProjectContext } from '../project/components';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink,
  type WorkEnvironmentData
} from './components';
import { activeWorkEnvironmentForRun, allowedWorkEnvironmentsForRun } from './queries';
import { formatWorkEnvironmentForDisplay } from '../../../../shared/workEnvironmentCatalog';

export const workEnvironmentToolSchemaContributor: ToolSchemaContributor = {
  key: 'workEnvironment',
  reads: {
    components: [
      Agent,
      AgentRun,
      AgentRunTargetLink,
      RunModeLink,
      AgentModeLink,
      Conversation,
      ConversationModeSelection,
      Mode,
      WorkEnvironment,
      WorkEnvironmentPolicy,
      WorkEnvironmentPolicyScopeLink,
      ConversationWorkEnvironmentLink,
      RunWorkEnvironmentLink,
      ConversationProjectLink,
      ProjectContext
    ]
  },
  augment(tools, context) {
    return tools.map((tool) => tool.name === SWITCH_WORK_ENVIRONMENT_TOOL_NAME
      ? augmentSwitchWorkEnvironmentTool(tool, context)
      : tool);
  }
};

function augmentSwitchWorkEnvironmentTool(tool: ToolSchema, context: Parameters<NonNullable<ToolSchemaContributor['augment']>>[1]): ToolSchema {
  const environmentText = workEnvironmentToolDefinitionText(context);
  return {
    ...tool,
    description: [tool.description, environmentText].filter(Boolean).join('\n\n'),
    parameters: withWorkEnvironmentIdParameterHints(tool.parameters, environmentText)
  };
}

function workEnvironmentToolDefinitionText(context: Parameters<NonNullable<ToolSchemaContributor['augment']>>[1]): string {
  const environments = allowedWorkEnvironmentsForRun(context.world, context.run);
  if (environments.length === 0) return '当前没有可切换的工作环境。';
  const current = activeWorkEnvironmentForRun(context.world, context.run);
  const lines = [
    '当前可切换工作环境（请传 workEnvironmentId 精确切换）：',
    ...environments.slice(0, 20).map((item) => `${current?.data.id === item.data.id ? '* 当前 ' : '- '}${formatToolEnvironmentLine(item.data)}`)
  ];
  if (environments.length > 20) lines.push(`...另有 ${environments.length - 20} 个工作环境未列出`);
  return lines.join('\n');
}

function formatToolEnvironmentLine(environment: WorkEnvironmentData): string {
  return formatWorkEnvironmentForDisplay(environment);
}

function withWorkEnvironmentIdParameterHints(parameters: unknown, environmentText: string): unknown {
  if (!isPlainObject(parameters)) return parameters;
  const properties = isPlainObject(parameters.properties) ? parameters.properties : undefined;
  const workEnvironmentId = isPlainObject(properties?.workEnvironmentId) ? properties.workEnvironmentId : undefined;
  if (!properties || !workEnvironmentId) return parameters;
  return {
    ...parameters,
    properties: {
      ...properties,
      workEnvironmentId: {
        ...workEnvironmentId,
        description: `${typeof workEnvironmentId.description === 'string' ? workEnvironmentId.description : '目标工作环境 id。'}\n${environmentText}`
      }
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
