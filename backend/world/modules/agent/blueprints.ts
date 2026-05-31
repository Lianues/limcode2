import { defineResource } from '../../../ecs/types';
import type { LlmProviderKind, ToolApprovalMode } from '../../../../shared/protocol';

export interface ModeModelProfileBlueprint {
  name?: string;
  provider: LlmProviderKind;
  model: string;
  temperature?: number;
}

export interface ModeToolPolicyBlueprint {
  name?: string;
  allowedTools: string[];
  approvalMode: ToolApprovalMode;
}

export interface AgentModeBlueprint {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model: ModeModelProfileBlueprint;
  toolPolicy: ModeToolPolicyBlueprint;
}

export interface AgentBlueprint {
  kind: string;
  name: string;
  defaultModeId: string;
  modes: AgentModeBlueprint[];
}

export type AgentBlueprintRegistry = Record<string, AgentBlueprint>;

export const AgentBlueprintsKey = defineResource<AgentBlueprintRegistry>('AgentBlueprints');

const DEFAULT_SYSTEM_PROMPT = 'You are LimCode, a concise and helpful AI coding assistant running inside VS Code. Reply in the user\'s language unless asked otherwise.';
const DEFAULT_MODEL = 'deepseek-v4-flash';

export function createDefaultAgentBlueprints(): AgentBlueprintRegistry {
  return {
    main: {
      kind: 'main',
      name: 'LimCode Agent',
      defaultModeId: 'default',
      modes: [
        {
          id: 'default',
          name: 'Default',
          description: '默认开发助手模式',
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          model: { name: 'Default Model', provider: 'deepseek', model: DEFAULT_MODEL, temperature: 0.2 },
          toolPolicy: { name: 'Default Tools', allowedTools: ['read_file', 'shell', 'bash'], approvalMode: 'never' }
        }
      ]
    },
    reviewer: {
      kind: 'reviewer',
      name: 'Code Reviewer',
      defaultModeId: 'review',
      modes: [
        {
          id: 'review',
          name: 'Review',
          description: '代码审查模式',
          systemPrompt: 'Review code and point out risks, bugs, and maintainability issues.',
          model: { name: 'Reviewer Model', provider: 'deepseek', model: DEFAULT_MODEL, temperature: 0.2 },
          toolPolicy: { name: 'Reviewer Tools', allowedTools: ['read_file', 'shell', 'bash'], approvalMode: 'never' }
        }
      ]
    }
  };
}
