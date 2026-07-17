import { defineResource } from '../../../ecs/types';
import type { LlmProviderKind, ToolPolicyToolConfigRecord } from '../../../../shared/protocol';
import {
  DELETE_TOOL_NAME,
  EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  SKILLS_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  WRITE_TOOL_NAME
} from '../../../../shared/protocol';

export interface BuiltinModelProfileDefinition {
  id?: string;
  name?: string;
  provider?: LlmProviderKind;
  model: string;
}

export interface BuiltinToolPolicyDefinition {
  id?: string;
  name?: string;
  allowedTools: string[];
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
}

export interface BuiltinAgentDefinition {
  id: string;
  kind: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model?: BuiltinModelProfileDefinition;
  toolPolicy: BuiltinToolPolicyDefinition;
}

export interface BuiltinModeDefinition {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: BuiltinModelProfileDefinition;
  toolPolicy?: BuiltinToolPolicyDefinition;
}

export interface BuiltinAgentRegistry {
  agents: Record<string, BuiltinAgentDefinition>;
  modes: Record<string, BuiltinModeDefinition>;
}

export const AgentBlueprintsKey = defineResource<BuiltinAgentRegistry>('AgentBlueprints');

export const DEFAULT_SYSTEM_PROMPT = 'You are LimCode, a concise and helpful AI coding assistant running inside VS Code. Reply in the user\'s language unless asked otherwise.';

export const DEFAULT_INTEGRATED_SYSTEM_PROMPT = [
  'You are {{$agent.name}}, a concise and helpful AI coding assistant running inside VS Code.',
  '{{$agent.description}}',
  '{{$mode.description}}',
  'Follow the active agent profile, active workflow, user instructions, and project rules. Reply in the user\'s language unless asked otherwise.'
].join('\n\n');

const DEFAULT_TOOLS = [TASK_LIST_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_TOOL_NAME, READ_TOOL_NAME, EDIT_TOOL_NAME, WRITE_TOOL_NAME, DELETE_TOOL_NAME, 'shell', 'bash', 'run_agent', SKILLS_TOOL_NAME, SUBMIT_AGENT_ANSWER_TOOL_NAME, READ_AGENT_ANSWER_TOOL_NAME];
const READONLY_TOOLS = [TASK_LIST_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, READ_TOOL_NAME, 'shell', 'bash', SKILLS_TOOL_NAME, SUBMIT_AGENT_ANSWER_TOOL_NAME, READ_AGENT_ANSWER_TOOL_NAME];
const DEFAULT_TOOL_CONFIGS: Record<string, ToolPolicyToolConfigRecord> = {};

export function createDefaultAgentBlueprints(): BuiltinAgentRegistry {
  return {
    agents: {
      main: {
        id: 'main',
        kind: 'main',
        name: 'LimCode Agent',
        description: 'General-purpose Agent for daily conversation and development collaboration.',
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        toolPolicy: { name: 'Main Agent Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      worker: {
        id: 'worker',
        kind: 'worker',
        name: 'Worker Agent',
        description: 'General-purpose worker Agent capable of multi-step tool operations.',
        systemPrompt: 'You are a peer LimCode worker agent. Complete assigned implementation or investigation tasks independently, use tools when useful, and report concise results with important details.',
        toolPolicy: { name: 'Worker Agent Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      explore: {
        id: 'explore',
        kind: 'explore',
        name: 'Explore Agent',
        description: 'Read-only Agent for searching, reading, and analyzing code.',
        systemPrompt: 'You are a read-only exploration agent. Inspect code, run safe read-only commands, and report findings. Do not modify files.',
        toolPolicy: { name: 'Explore Agent Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      reviewer: {
        id: 'reviewer',
        kind: 'reviewer',
        name: 'Reviewer',
        description: 'Review code, design, risks, bugs, and maintainability issues. Only use when you are uncertain about the consequences of changes — skip trivial/small modifications and changes you are confident about.',
        systemPrompt: 'Review code, design, risks, bugs, and maintainability issues. Do not modify files unless explicitly requested. Only use this reviewer when you are uncertain about the consequences of changes — skip trivial/small modifications and changes you are confident about.',
        toolPolicy: { name: 'Reviewer Agent Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      }
    },
    modes: {
      plan: {
        id: 'builtin:plan',
        name: 'Plan',
        description: 'Plan first: analyze requirements, identify risks, and decompose tasks before implementation.',
        systemPrompt: 'Plan first. Analyze requirements, identify risks, and present a concise implementation plan before making large changes.'
      },
      review: {
        id: 'builtin:review',
        name: 'Review',
        description: 'Review workflow: assess risks, correctness, regressions, security, and maintainability.',
        systemPrompt: 'Act in review workflow. Focus on correctness, risks, regressions, security, maintainability, and concrete improvement suggestions.',
        toolPolicy: { name: 'Review Workflow Tool Narrowing', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      readonly: {
        id: 'builtin:readonly',
        name: 'Read Only',
        description: 'Read-only exploration workflow with tool narrowing to read-only tools.',
        systemPrompt: 'Use read-only exploration workflow. Do not modify files or execute destructive commands.',
        toolPolicy: { name: 'Read Only Workflow Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      }
    }
  };
}
