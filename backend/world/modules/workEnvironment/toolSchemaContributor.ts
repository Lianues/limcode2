import { SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_TOOL_NAME } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import type { ToolSchemaContributor } from '../tools/schemaContributors';
import { Agent } from '../agent/components';
import { AgentRun, AgentRunTargetLink, RunModeLink } from '../agentRun/components';
import { ConversationModeSelection, Mode } from '../mode/components';
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
import { allowedWorkEnvironmentsForRun, effectiveWorkEnvironmentPolicyForRun } from './queries';
import { formatWorkEnvironmentForDisplay } from '../../../../shared/workEnvironmentCatalog';

export const workEnvironmentToolSchemaContributor: ToolSchemaContributor = {
  key: 'workEnvironment',
  reads: {
    components: [
      Agent,
      AgentRun,
      AgentRunTargetLink,
      RunModeLink,
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
    if (effectiveWorkEnvironmentPolicyForRun(context.world, context.run).policy?.enabled !== true) {
      return tools.filter((tool) => tool.name !== SWITCH_WORK_ENVIRONMENT_TOOL_NAME && tool.name !== TRANSFER_TOOL_NAME);
    }

    return tools.map((tool) => {
      if (tool.name === SWITCH_WORK_ENVIRONMENT_TOOL_NAME) return augmentSwitchWorkEnvironmentTool(tool, context);
      if (tool.name === TRANSFER_TOOL_NAME) return augmentTransferFilesTool(tool, context);
      return tool;
    });
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

function augmentTransferFilesTool(tool: ToolSchema, context: Parameters<NonNullable<ToolSchemaContributor['augment']>>[1]): ToolSchema {
  const environmentText = workEnvironmentToolDefinitionText(context, 'Work environments available for file transfer (pass the id for fromEnvironment/toEnvironment; current refers to the active one):');
  return {
    ...tool,
    description: [tool.description, environmentText].filter(Boolean).join('\n\n'),
    parameters: withTransferEnvironmentParameterHints(tool.parameters, environmentText)
  };
}

function workEnvironmentToolDefinitionText(context: Parameters<NonNullable<ToolSchemaContributor['augment']>>[1], title = 'Switchable work environments (pass workEnvironmentId to switch precisely):'): string {
  const environments = allowedWorkEnvironmentsForRun(context.world, context.run);
  if (environments.length === 0) return 'There are currently no switchable work environments.';
  const lines = [
    title,
    ...environments.slice(0, 20).map((item) => `- ${formatToolEnvironmentLine(item.data)}`)
  ];
  if (environments.length > 20) lines.push(`...and ${environments.length - 20} more work environment(s) not listed`);
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
        description: `${typeof workEnvironmentId.description === 'string' ? workEnvironmentId.description : 'Target work environment id.'}\n${environmentText}`
      }
    }
  };
}

function withTransferEnvironmentParameterHints(parameters: unknown, environmentText: string): unknown {
  if (!isPlainObject(parameters)) return parameters;
  const properties = isPlainObject(parameters.properties) ? parameters.properties : undefined;
  const transfers = isPlainObject(properties?.transfers) ? properties.transfers : undefined;
  const items = isPlainObject(transfers?.items) ? transfers.items : undefined;
  const itemProperties = isPlainObject(items?.properties) ? items.properties : undefined;
  if (!properties || !transfers || !items || !itemProperties) return parameters;
  return {
    ...parameters,
    properties: {
      ...properties,
      transfers: {
        ...transfers,
        items: {
          ...items,
          properties: withEnvironmentFieldDescriptions(itemProperties, environmentText)
        }
      }
    }
  };
}

function withEnvironmentFieldDescriptions(properties: Record<string, unknown>, environmentText: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    if ((key === 'fromEnvironment' || key === 'toEnvironment') && isPlainObject(value)) {
      return [key, {
        ...value,
        description: `${typeof value.description === 'string' ? value.description : 'Work environment id.'}\n${environmentText}`
      }];
    }
    return [key, value];
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
