import { taskListOperationFromArgs } from './taskListProjection';
import type {
  PlanProposalStatus,
  SubmitPlanDecisionStatus,
  SubmitPlanDelegationStatus,
  SubmitPlanExecutionTarget,
  SubmitPlanToolOutputRecord,
  SubmitPlanToolRequestRecord,
  TaskListToolOperationRecord
} from './protocol';

export const SUBMIT_PLAN_MAX_BODY_LENGTH = 40_000;
export const DELEGATED_PLAN_APPROVAL_MESSAGE = 'Plan 已下发给 Agent 执行，请耐心等待。';

export function normalizeSubmitPlanToolRequest(value: unknown): SubmitPlanToolRequestRecord {
  const record = asRecord(parseJsonValue(value));
  if (!record) throw new Error('submit_plan arguments must be an object');

  const plan = requiredText(record.plan, 'plan', SUBMIT_PLAN_MAX_BODY_LENGTH);
  const taskList = optionalTaskList(record.taskList);

  return {
    plan,
    ...(taskList ? { taskList } : {})
  };
}

export function submitPlanRequestFromArgs(value: unknown): SubmitPlanToolRequestRecord | undefined {
  try {
    return normalizeSubmitPlanToolRequest(value);
  } catch {
    return undefined;
  }
}

export function createSubmitPlanToolOutput(input: {
  proposalId: string;
  status: SubmitPlanDecisionStatus;
  userMessage?: string;
  executionTarget?: SubmitPlanExecutionTarget;
  delegationStatus?: SubmitPlanDelegationStatus;
  agentId?: string;
  agentType?: string;
  runId?: string;
  conversationId?: string;
  answerBridgeId?: string;
}): SubmitPlanToolOutputRecord {
  const userMessage = input.userMessage?.trim();
  return {
    kind: 'submit_plan.result',
    proposalId: input.proposalId,
    status: input.status,
    ...(userMessage ? { userMessage } : {}),
    ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
    ...(input.delegationStatus ? { delegationStatus: input.delegationStatus } : {}),
    ...optionalOutputId('agentId', input.agentId),
    ...optionalOutputId('agentType', input.agentType),
    ...optionalOutputId('runId', input.runId),
    ...optionalOutputId('conversationId', input.conversationId),
    ...optionalOutputId('answerBridgeId', input.answerBridgeId)
  };
}

export function submitPlanOutputFromResult(value: unknown): SubmitPlanToolOutputRecord | undefined {
  const envelope = asRecord(value);
  const rawOutput = envelope && 'output' in envelope ? envelope.output : value;
  const output = asRecord(rawOutput);
  if (!output || output.kind !== 'submit_plan.result') return undefined;
  if (typeof output.proposalId !== 'string' || !output.proposalId.trim()) return undefined;
  if (!isSubmitPlanDecisionStatus(output.status)) return undefined;

  const userMessage = optionalText(output.userMessage);
  const executionTarget = isSubmitPlanExecutionTarget(output.executionTarget) ? output.executionTarget : undefined;
  const delegationStatus = output.delegationStatus === 'backgrounded' ? output.delegationStatus : undefined;
  const agentId = optionalText(output.agentId);
  const agentType = optionalText(output.agentType);
  const runId = optionalText(output.runId);
  const conversationId = optionalText(output.conversationId);
  const answerBridgeId = optionalText(output.answerBridgeId);
  return {
    kind: 'submit_plan.result',
    proposalId: output.proposalId.trim(),
    status: output.status,
    ...(userMessage ? { userMessage } : {}),
    ...(executionTarget ? { executionTarget } : {}),
    ...(delegationStatus ? { delegationStatus } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(runId ? { runId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(answerBridgeId ? { answerBridgeId } : {})
  };
}

export function planProposalStatusToDecision(status: PlanProposalStatus): SubmitPlanDecisionStatus | undefined {
  if (status === 'approved' || status === 'change_requested' || status === 'rejected') return status;
  return undefined;
}

function isSubmitPlanDecisionStatus(value: unknown): value is SubmitPlanDecisionStatus {
  return value === 'approved' || value === 'change_requested' || value === 'rejected';
}

function isSubmitPlanExecutionTarget(value: unknown): value is SubmitPlanExecutionTarget {
  return value === 'current_conversation' || value === 'new_conversation';
}

function optionalOutputId<TKey extends 'agentId' | 'agentType' | 'runId' | 'conversationId' | 'answerBridgeId'>(
  key: TKey,
  value: string | undefined
): { [K in TKey]?: string } {
  const id = value?.trim();
  return id ? { [key]: id } as { [K in TKey]?: string } : {};
}

function optionalTaskList(value: unknown): TaskListToolOperationRecord | undefined {
  if (value === undefined) return undefined;
  const operation = taskListOperationFromArgs(value);
  if (!operation) throw new Error('taskList must use the same shape as update_task_list: { mode, items }');
  return cloneTaskListOperation(operation);
}

function cloneTaskListOperation(operation: TaskListToolOperationRecord): TaskListToolOperationRecord {
  return {
    kind: 'task_list.operation',
    mode: operation.mode,
    items: operation.items.map((item) => ({
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      ...(item.status ? { status: item.status } : {}),
      ...(item.delete ? { delete: true } : {})
    }))
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('submit_plan arguments must be valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must be a non-empty string`);
  if (text.length > maxLength) throw new Error(`${label} must not exceed ${maxLength} characters`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}
