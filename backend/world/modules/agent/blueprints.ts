import { defineResource } from '../../../ecs/types';
import type { LlmProviderKind, ToolPolicyToolConfigRecord } from '../../../../shared/protocol';
import {
  EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TRANSFER_FILES_TOOL_NAME,
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
const DEFAULT_TOOLS = [TASK_LIST_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_FILES_TOOL_NAME, READ_TOOL_NAME, EDIT_TOOL_NAME, WRITE_TOOL_NAME, 'shell', 'bash', 'run_agent', 'read_conversation', SUBMIT_AGENT_ANSWER_TOOL_NAME, READ_AGENT_ANSWER_TOOL_NAME];
const READONLY_TOOLS = [TASK_LIST_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, READ_TOOL_NAME, 'shell', 'bash', 'read_conversation', SUBMIT_AGENT_ANSWER_TOOL_NAME, READ_AGENT_ANSWER_TOOL_NAME];
const DEFAULT_TOOL_CONFIGS = {
  [TASK_LIST_TOOL_NAME]: { config: {}, display: { autoExpand: true } },
  [EDIT_TOOL_NAME]: { config: {}, autoApproveExecution: false },
  [WRITE_TOOL_NAME]: { config: {}, autoApproveExecution: false }
} satisfies Record<string, ToolPolicyToolConfigRecord>;

export function createDefaultAgentBlueprints(): BuiltinAgentRegistry {
  return {
    agents: {
      main: {
        id: 'main',
        kind: 'main',
        name: 'LimCode Agent',
        description: '日常对话和开发协作的默认 Agent。',
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        toolPolicy: { name: 'Main Agent Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      worker: {
        id: 'worker',
        kind: 'worker',
        name: 'Worker Agent',
        description: '可执行多步工具操作的通用工作 Agent。',
        systemPrompt: 'You are a peer LimCode worker agent. Complete assigned implementation or investigation tasks independently, use tools when useful, and report concise results with important details.',
        toolPolicy: { name: 'Worker Agent Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      'general-purpose': {
        id: 'general-purpose',
        kind: 'general-purpose',
        name: 'General Purpose Agent',
        description: '兼容 run_agent 默认 type 的通用 Agent。',
        systemPrompt: 'You are an autonomous peer execution subject in LimCode. Complete delegated tasks independently, use tools when useful, and return a concise result with findings.',
        toolPolicy: { name: 'General Purpose Agent Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      explore: {
        id: 'explore',
        kind: 'explore',
        name: 'Explore Agent',
        description: '只读搜索、阅读和分析代码的 Agent。',
        systemPrompt: 'You are a read-only exploration agent. Inspect code, run safe read-only commands, and report findings. Do not modify files.',
        toolPolicy: { name: 'Explore Agent Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      reviewer: {
        id: 'reviewer',
        kind: 'reviewer',
        name: 'Code Reviewer',
        description: '审查代码、风险和维护性问题的 Agent。',
        systemPrompt: 'Review code and point out risks, bugs, and maintainability issues. Do not modify files unless explicitly requested.',
        toolPolicy: { name: 'Reviewer Agent Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      }
    },
    modes: {
      default: {
        id: 'default',
        name: 'Default',
        description: '默认交互模式，尽量少加额外约束。'
      },
      plan: {
        id: 'builtin:plan',
        name: 'Plan',
        description: '先规划、分析和拆解任务，再执行后续实现。',
        systemPrompt: 'Plan first. Analyze requirements, identify risks, and present a concise implementation plan before making large changes.'
      },
      review: {
        id: 'builtin:review',
        name: 'Review',
        description: '以代码审查方式输出风险、问题和建议。',
        systemPrompt: 'Act in review mode. Focus on correctness, risks, regressions, security, maintainability, and concrete improvement suggestions.',
        toolPolicy: { name: 'Review Mode Tool Narrowing', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      readonly: {
        id: 'builtin:readonly',
        name: 'Read Only',
        description: '只读探索模式，会收窄到只读工具。',
        systemPrompt: 'Use read-only exploration. Do not modify files or execute destructive commands.',
        toolPolicy: { name: 'Read Only Mode Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      }
    }
  };
}
