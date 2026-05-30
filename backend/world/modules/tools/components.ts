import { defineComponent } from '../../../ecs/types';
import type { ToolCallEventKind, ToolCallStatus } from '../../../../shared/protocol';

export interface ToolCallData {
  id: string;
  name: string;
  functionCallId?: string;
  argsJson: string;
  createdAt: number;
}
export const ToolCall = defineComponent<ToolCallData>('ToolCall');

export interface ToolStateData {
  status: ToolCallStatus;
  updatedAt: number;
  result?: unknown;
  error?: string;
  progress?: unknown;
  durationMs?: number;
}
export const ToolState = defineComponent<ToolStateData>('ToolState');

export interface ToolCallEventData {
  id: string;
  toolCallId: string;
  seq: number;
  kind: ToolCallEventKind;
  at: number;
  status?: ToolCallStatus;
  elapsedMs?: number;
  durationMs?: number;
  delta?: string;
  payload?: unknown;
  error?: string;
}
export const ToolCallEvent = defineComponent<ToolCallEventData>('ToolCallEvent');

export const ToolResultConsumed = defineComponent<true>('ToolResultConsumed');
