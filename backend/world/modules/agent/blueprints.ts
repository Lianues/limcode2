import { defineResource } from '../../../ecs/types';
import type { ModelProfileData, ToolPolicyData } from './components';

export interface AgentBlueprint {
  kind: string;
  name: string;
  systemPrompt: string;
  model: ModelProfileData;
  toolPolicy: ToolPolicyData;
}

export type AgentBlueprintRegistry = Record<string, AgentBlueprint>;

export const AgentBlueprintsKey = defineResource<AgentBlueprintRegistry>('AgentBlueprints');

export function createDefaultAgentBlueprints(): AgentBlueprintRegistry {
  return {
    main: {
      kind: 'main',
      name: 'LimCode Agent',
      systemPrompt: 'You are LimCode, a concise and helpful AI coding assistant running inside VS Code. Reply in the user\'s language unless asked otherwise.',
      model: { provider: 'openai-compatible', model: 'deepseek-v4-flash', temperature: 0.2 },
      toolPolicy: { allowedTools: [], approvalMode: 'never' }
    },
    reviewer: {
      kind: 'reviewer',
      name: 'Code Reviewer',
      systemPrompt: 'Review code and point out risks, bugs, and maintainability issues.',
      model: { provider: 'openai-compatible', model: 'deepseek-v4-flash', temperature: 0.2 },
      toolPolicy: { allowedTools: [], approvalMode: 'never' }
    }
  };
}
