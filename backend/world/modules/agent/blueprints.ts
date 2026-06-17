import { defineResource } from '../../../ecs/types';
import type {
  ContextHistoryMode,
  ConversationPolicyMode,
  ConversationVisibility,
  DeliveryMode,
  LlmProviderKind,
  NewMessageWhileRunningBehavior,
  SourceEditBehavior,
  TranscriptInclusion,
  ToolPolicyToolConfigRecord
} from '../../../../shared/protocol';
import { SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TASK_LIST_TOOL_NAME, TRANSFER_FILES_TOOL_NAME } from '../../../../shared/protocol';

export interface ModeModelProfileBlueprint {
  name?: string;
  provider: LlmProviderKind;
  model: string;
}

export interface ModeToolPolicyBlueprint {
  name?: string;
  allowedTools: string[];
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
}

export interface RunConversationPolicyBlueprint {
  mode: ConversationPolicyMode;
  visibility?: ConversationVisibility;
  reuseKey?: string;
  conversationId?: string;
}

export interface RunContextPolicyBlueprint {
  historyMode: ContextHistoryMode;
  lastN?: number;
  sinceMessageId?: string;
  selectedMessageIds?: string[];
  includeSourceContext?: boolean;
  includeSourceToolResult?: boolean;
}

export interface RunDeliveryPolicyBlueprint {
  mode: DeliveryMode;
  includeTranscript: TranscriptInclusion;
}

export interface RunEditPolicyBlueprint {
  onSourceEdited: SourceEditBehavior;
  onNewUserMessageWhileRunning: NewMessageWhileRunningBehavior;
}

export interface AgentModeBlueprint {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model: ModeModelProfileBlueprint;
  toolPolicy: ModeToolPolicyBlueprint;
  conversationPolicy?: RunConversationPolicyBlueprint;
  contextPolicy?: RunContextPolicyBlueprint;
  deliveryPolicy?: RunDeliveryPolicyBlueprint;
  editPolicy?: RunEditPolicyBlueprint;
}

export interface AgentBlueprint {
  kind: string;
  name: string;
  defaultModeId: string;
  modes: AgentModeBlueprint[];
  defaultConversationPolicy?: RunConversationPolicyBlueprint;
  defaultContextPolicy?: RunContextPolicyBlueprint;
  defaultDeliveryPolicy?: RunDeliveryPolicyBlueprint;
  defaultEditPolicy?: RunEditPolicyBlueprint;
}

export type AgentBlueprintRegistry = Record<string, AgentBlueprint>;

export const AgentBlueprintsKey = defineResource<AgentBlueprintRegistry>('AgentBlueprints');

const DEFAULT_SYSTEM_PROMPT = 'You are LimCode, a concise and helpful AI coding assistant running inside VS Code. Reply in the user\'s language unless asked otherwise.';
const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_TOOLS = [TASK_LIST_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_FILES_TOOL_NAME, 'read_file', 'shell', 'bash', 'run_agent'];
const READONLY_TOOLS = [TASK_LIST_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, 'read_file', 'shell', 'bash'];
const DEFAULT_TOOL_CONFIGS = {
  [TASK_LIST_TOOL_NAME]: { config: {}, display: { autoExpand: true } }
} satisfies Record<string, ToolPolicyToolConfigRecord>;
const DEFAULT_CONTEXT_POLICY: RunContextPolicyBlueprint = { historyMode: 'full' };
const DEFAULT_EDIT_POLICY: RunEditPolicyBlueprint = { onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' };

export function createDefaultAgentBlueprints(): AgentBlueprintRegistry {
  return {
    main: {
      kind: 'main',
      name: 'LimCode Agent',
      defaultModeId: 'default',
      defaultConversationPolicy: { mode: 'same_conversation', visibility: 'visible' },
      defaultContextPolicy: DEFAULT_CONTEXT_POLICY,
      defaultDeliveryPolicy: { mode: 'direct_reply', includeTranscript: 'full' },
      defaultEditPolicy: DEFAULT_EDIT_POLICY,
      modes: [
        {
          id: 'default',
          name: 'Default',
          description: '默认开发助手模式',
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          model: { name: 'Default Model', provider: 'openai-compatible', model: DEFAULT_MODEL },
          toolPolicy: { name: 'Default Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
        }
      ]
    },
    reviewer: {
      kind: 'reviewer',
      name: 'Code Reviewer',
      defaultModeId: 'review',
      defaultConversationPolicy: { mode: 'new_conversation', visibility: 'collapsed' },
      defaultContextPolicy: DEFAULT_CONTEXT_POLICY,
      defaultDeliveryPolicy: { mode: 'tool_response', includeTranscript: 'summary' },
      defaultEditPolicy: DEFAULT_EDIT_POLICY,
      modes: [
        {
          id: 'review',
          name: 'Review',
          description: '代码审查模式',
          systemPrompt: 'Review code and point out risks, bugs, and maintainability issues. Do not modify files unless explicitly requested.',
          model: { name: 'Reviewer Model', provider: 'openai-compatible', model: DEFAULT_MODEL },
          toolPolicy: { name: 'Reviewer Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
        }
      ]
    },
    'general-purpose': {
      kind: 'general-purpose',
      name: 'General Purpose Agent',
      defaultModeId: 'default',
      defaultConversationPolicy: { mode: 'new_conversation', visibility: 'collapsed' },
      defaultContextPolicy: DEFAULT_CONTEXT_POLICY,
      defaultDeliveryPolicy: { mode: 'tool_response', includeTranscript: 'summary' },
      defaultEditPolicy: DEFAULT_EDIT_POLICY,
      modes: [
        {
          id: 'default',
          name: 'General Purpose',
          description: '可执行多步工具操作的通用子任务执行者',
          systemPrompt: 'You are an autonomous agent running in the same LimCode execution system. Complete the delegated task independently, use tools when useful, and return a concise result with important findings. You are not lower priority than any other agent; you are a peer execution subject.',
          model: { name: 'General Purpose Model', provider: 'openai-compatible', model: DEFAULT_MODEL },
          toolPolicy: { name: 'General Purpose Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
        }
      ]
    },
    explore: {
      kind: 'explore',
      name: 'Explore Agent',
      defaultModeId: 'explore',
      defaultConversationPolicy: { mode: 'new_conversation', visibility: 'collapsed' },
      defaultContextPolicy: DEFAULT_CONTEXT_POLICY,
      defaultDeliveryPolicy: { mode: 'tool_response', includeTranscript: 'summary' },
      defaultEditPolicy: { onSourceEdited: 'ignore_snapshot', onNewUserMessageWhileRunning: 'queue_next_run' },
      modes: [
        {
          id: 'explore',
          name: 'Explore',
          description: '只读搜索、阅读和分析代码的执行者',
          systemPrompt: 'You are a read-only exploration agent. Inspect code, run safe read-only commands, and report findings. Do not modify files.',
          model: { name: 'Explore Model', provider: 'openai-compatible', model: DEFAULT_MODEL },
          toolPolicy: { name: 'Explore Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
        }
      ]
    }
  };
}
