import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  AgentRunKind,
  AgentRunEndReason,
  AgentRunErrorType,
  AgentRunSourceKind,
  AgentRunStatus,
  AgentRunTargetRole,
  ContextHistoryMode,
  ConversationPolicyMode,
  ConversationVisibility,
  DeliveryMode,
  MessageRunRole,
  NewMessageWhileRunningBehavior,
  PolicyBindingRole,
  SourceEditBehavior,
  ToolCallRunRole,
  TranscriptInclusion,
  LlmUsageMetadataRecord,
  MessageContent,
  AgentRunQueueHoldReason
} from '../../../../shared/protocol';

export interface AgentRunData {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  endReason?: AgentRunEndReason;
  errorType?: AgentRunErrorType;
  error?: string;
  usageMetadata?: LlmUsageMetadataRecord;
  retryOfRunId?: string;
  attempt?: number;
}
export const AgentRun = defineComponent<AgentRunData>('AgentRun');

/** Run-scoped trigger for the next LLM cycle. Replaces conversation-level NeedsResponse. */
export const AgentRunNeedsModel = defineComponent<{ since: number }>('AgentRunNeedsModel');

export interface AgentRunSourceLinkData {
  id: string;
  run: Entity;
  sourceKind: AgentRunSourceKind;
  sourceAgent?: Entity;
  sourceConversation?: Entity;
  sourceMessage?: Entity;
  sourceToolCall?: Entity;
  sourceRun?: Entity;
  answerBridgeId?: string;
  createdAt: number;
  updatedAt: number;
}
export const AgentRunSourceLink = defineComponent<AgentRunSourceLinkData>('AgentRunSourceLink');

export interface AgentRunTargetLinkData {
  id: string;
  run: Entity;
  agent: Entity;
  conversation: Entity;
  role: AgentRunTargetRole;
  createdAt: number;
  updatedAt: number;
}
export const AgentRunTargetLink = defineComponent<AgentRunTargetLinkData>('AgentRunTargetLink');

export interface AgentRunQueueOrderData {
  id: string;
  run: Entity;
  conversation: Entity;
  order: number;
  createdAt: number;
  updatedAt: number;
}
export const AgentRunQueueOrder = defineComponent<AgentRunQueueOrderData>('AgentRunQueueOrder');

export interface AgentRunQueueHoldData {
  id: string;
  run: Entity;
  conversation: Entity;
  reason: AgentRunQueueHoldReason;
  createdAt: number;
  updatedAt: number;
}
export const AgentRunQueueHold = defineComponent<AgentRunQueueHoldData>('AgentRunQueueHold');

export interface AgentRunQueuedInputData {
  id: string;
  run: Entity;
  conversation: Entity;
  content: MessageContent;
  createdAt: number;
  updatedAt: number;
}
export const AgentRunQueuedInput = defineComponent<AgentRunQueuedInputData>('AgentRunQueuedInput');

export interface MessageRunLinkData {
  id: string;
  message: Entity;
  run: Entity;
  role: MessageRunRole;
  createdAt: number;
  updatedAt: number;
}
export const MessageRunLink = defineComponent<MessageRunLinkData>('MessageRunLink');

export interface ToolCallRunLinkData {
  id: string;
  toolCall: Entity;
  run: Entity;
  role: ToolCallRunRole;
  createdAt: number;
  updatedAt: number;
}
export const ToolCallRunLink = defineComponent<ToolCallRunLinkData>('ToolCallRunLink');

export interface RunConversationPolicyData {
  id: string;
  mode: ConversationPolicyMode;
  conversationId?: string;
  reuseKey?: string;
  branchFromConversationId?: string;
  branchFromRevisionId?: string;
  visibility: ConversationVisibility;
}
export const RunConversationPolicy = defineComponent<RunConversationPolicyData>('RunConversationPolicy');

export interface RunContextPolicyData {
  id: string;
  historyMode: ContextHistoryMode;
  lastN?: number;
  sinceMessageId?: string;
  selectedMessageIds?: string[];
  includeSourceContext?: boolean;
  includeSourceToolResult?: boolean;
}
export const RunContextPolicy = defineComponent<RunContextPolicyData>('RunContextPolicy');

export interface RunDeliveryPolicyData {
  id: string;
  mode: DeliveryMode;
  includeTranscript: TranscriptInclusion;
  targetConversation?: Entity;
  targetToolCall?: Entity;
}
export const RunDeliveryPolicy = defineComponent<RunDeliveryPolicyData>('RunDeliveryPolicy');

export interface RunEditPolicyData {
  id: string;
  onSourceEdited: SourceEditBehavior;
  onNewUserMessageWhileRunning: NewMessageWhileRunningBehavior;
}
export const RunEditPolicy = defineComponent<RunEditPolicyData>('RunEditPolicy');

export interface RunWorkflowLinkData {
  id: string;
  run: Entity;
  workflow: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunWorkflowLink = defineComponent<RunWorkflowLinkData>('RunWorkflowLink');

export interface RunSystemPromptLinkData {
  id: string;
  run: Entity;
  systemPrompt: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunSystemPromptLink = defineComponent<RunSystemPromptLinkData>('RunSystemPromptLink');

export interface RunModelProfileLinkData {
  id: string;
  run: Entity;
  modelProfile: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunModelProfileLink = defineComponent<RunModelProfileLinkData>('RunModelProfileLink');

export interface RunToolPolicyLinkData {
  id: string;
  run: Entity;
  toolPolicy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunToolPolicyLink = defineComponent<RunToolPolicyLinkData>('RunToolPolicyLink');


export interface RunConversationPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunConversationPolicyLink = defineComponent<RunConversationPolicyLinkData>('RunConversationPolicyLink');

export interface RunContextPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunContextPolicyLink = defineComponent<RunContextPolicyLinkData>('RunContextPolicyLink');

export interface RunDeliveryPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunDeliveryPolicyLink = defineComponent<RunDeliveryPolicyLinkData>('RunDeliveryPolicyLink');

export interface RunEditPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunEditPolicyLink = defineComponent<RunEditPolicyLinkData>('RunEditPolicyLink');

export interface AgentRunInputRevisionData {
  id: string;
  run: Entity;
  conversation: Entity;
  revision: Entity;
}
export const AgentRunInputRevision = defineComponent<AgentRunInputRevisionData>('AgentRunInputRevision');
