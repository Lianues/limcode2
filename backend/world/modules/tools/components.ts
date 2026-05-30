import { defineComponent } from '../../../ecs/types';
import type { ToolCallStatus } from '../../../../shared/protocol';

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
}
export const ToolState = defineComponent<ToolStateData>('ToolState');

export const ToolResultConsumed = defineComponent<true>('ToolResultConsumed');
