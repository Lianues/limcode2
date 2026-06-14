import type { ToolCallEventRecord } from '@shared/protocol';

export interface ToolDisplayRow {
  label: string;
  value: string;
}

export interface ToolDisplaySection {
  kind: 'input' | 'output';
  title: string;
  text?: string;
  rows?: ToolDisplayRow[];
  rowStyle?: 'keyValue' | 'lineNumber';
}

export interface ToolDisplayContext {
  toolName: string;
  args: unknown;
  result?: unknown;
  progress?: unknown;
  events: ToolCallEventRecord[];
  stringifyValue(value: unknown): string;
}

export interface ToolDisplayResult {
  inputSections: ToolDisplaySection[];
  outputSections: ToolDisplaySection[];
}

export type ToolDisplayResolver = (context: ToolDisplayContext) => Partial<ToolDisplayResult> | undefined;
