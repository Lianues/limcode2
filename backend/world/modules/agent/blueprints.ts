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
      systemPrompt: 'You are LimCode, a coding assistant running inside VS Code.',
      model: { provider: 'fake', model: 'fake' },
      toolPolicy: { allowedTools: ['read_file'], approvalMode: 'never' }
    },
    reviewer: {
      kind: 'reviewer',
      name: 'Code Reviewer',
      systemPrompt: 'Review code and point out risks, bugs, and maintainability issues.',
      model: { provider: 'fake', model: 'fake' },
      toolPolicy: { allowedTools: ['read_file'], approvalMode: 'never' }
    }
  };
}
