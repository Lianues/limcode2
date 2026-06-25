import { EDIT_TOOL_NAME } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import { Agent, ConversationAgentSelection } from '../agent/components';
import { AgentRun, AgentRunTargetLink, RunModeLink, RunToolPolicyLink } from '../agentRun/components';
import { activeToolPolicyForRun } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { ConversationModeSelection, Mode, ToolPolicy } from '../mode/components';
import {
  deleteModeParameters,
  editModeFromConfig,
  hunkModeDescription,
  hunkModeParameters,
  insertDeleteDescription,
  insertModeParameters,
  patchModeDescription,
  patchModeParameters
} from './definitions/edit';
import { ToolPolicyScopeLink } from './components';
import type { ToolSchemaContributor } from './schemaContributors';

export const editToolSchemaContributor: ToolSchemaContributor = {
  key: 'editToolMode',
  reads: {
    components: [
      Agent,
      ConversationAgentSelection,
      AgentRun,
      AgentRunTargetLink,
      RunModeLink,
      RunToolPolicyLink,
      Conversation,
      ConversationModeSelection,
      Mode,
      ToolPolicy,
      ToolPolicyScopeLink
    ]
  },
  augment(tools, context) {
    const policy = activeToolPolicyForRun(context.world, context.run);
    const mode = editModeFromConfig(policy?.toolConfigs?.[EDIT_TOOL_NAME]?.config);
    return tools.map((tool): ToolSchema => {
      if (tool.name !== EDIT_TOOL_NAME) return tool;
      const baseDescription = mode === 'patch' ? patchModeDescription() : hunkModeDescription();
      const baseParameters = mode === 'patch' ? patchModeParameters() : hunkModeParameters();
      return {
        ...tool,
        description: `${baseDescription}\n${insertDeleteDescription()}`,
        parameters: mergeInsertDeleteParams(baseParameters)
      };
    });
  }
};

function mergeInsertDeleteParams(baseParams: unknown): unknown {
  const base = baseParams as { type: string; properties: Record<string, unknown>; required: string[] };
  return {
    ...base,
    properties: {
      ...base.properties,
      insert: insertModeParameters(),
      delete: deleteModeParameters()
    },
    required: ['path']
  };
}
