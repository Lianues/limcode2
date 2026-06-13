import { TERMINAL_TOOL_CALL_STATUSES, type ToolCallStatus } from '../../../../shared/protocol';
import type { ToolStateData } from './components';

export type ToolTerminalStatus = Extract<ToolCallStatus, 'success' | 'warning' | 'error'>;

export interface ToolStateTransitionPayload {
  result?: unknown;
  error?: string;
  progress?: unknown;
  delta?: string;
  durationMs?: number;
}

const VALID_TRANSITIONS: Record<ToolCallStatus, readonly ToolCallStatus[]> = {
  streaming: ['queued', 'error'],
  queued: ['awaiting_approval', 'awaiting_apply', 'executing', 'error'],
  awaiting_approval: ['awaiting_apply', 'executing', 'success', 'warning', 'error'],
  executing: ['executing', 'awaiting_approval', 'awaiting_apply', 'success', 'warning', 'error'],
  awaiting_apply: ['executing', 'success', 'warning', 'error'],
  success: ['awaiting_apply'],
  warning: ['awaiting_apply'],
  error: ['awaiting_apply']
};

export function createToolState(status: ToolCallStatus = 'queued', now = Date.now()): ToolStateData {
  return { status, updatedAt: now };
}

export function isTerminalToolStatus(status: ToolCallStatus): status is ToolTerminalStatus {
  return TERMINAL_TOOL_CALL_STATUSES.has(status);
}

export function assertValidToolTransition(previous: ToolCallStatus, next: ToolCallStatus): void {
  if (!VALID_TRANSITIONS[previous].includes(next)) {
    throw new Error(`非法工具状态转换: ${previous} → ${next}`);
  }
}

export function transitionToolState(
  current: ToolStateData,
  nextStatus: ToolCallStatus,
  payload: ToolStateTransitionPayload = {},
  now = Date.now()
): ToolStateData {
  assertValidToolTransition(current.status, nextStatus);
  return {
    ...current,
    status: nextStatus,
    updatedAt: now,
    ...(payload.result !== undefined ? { result: payload.result } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload.progress !== undefined ? { progress: payload.progress } : {}),
    ...(payload.delta !== undefined ? { progress: payload.delta } : {}),
    ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {})
  };
}

export function toolStateToResponse(state: ToolStateData): unknown {
  if (state.result !== undefined) return state.result;
  if (state.error) return { error: state.error };
  return { status: state.status };
}
