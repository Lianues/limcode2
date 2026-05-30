import { defineComponent } from '../../../ecs/types';

export interface ToolCallData {
  id: string;
  name: string;
  functionCallId?: string;
  argsJson: string;
}
export const ToolCall = defineComponent<ToolCallData>('ToolCall');

export const PendingTool = defineComponent<true>('PendingTool');
export const RunningTool = defineComponent<true>('RunningTool');

export interface ToolResultData {
  ok: boolean;
  output: string;
}
export const ToolResult = defineComponent<ToolResultData>('ToolResult');

export const ToolCompleted = defineComponent<true>('ToolCompleted');
export const ToolFailed = defineComponent<true>('ToolFailed');
export const ToolResultConsumed = defineComponent<true>('ToolResultConsumed');
