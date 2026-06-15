import { TASK_LIST_TOOL_NAME } from '@shared/protocol';
import { readFileToolDisplay } from './readFileToolDisplay';
import { shellToolDisplay } from './shellToolDisplay';
import { taskListToolDisplay } from './taskListToolDisplay';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplayResult, ToolDisplaySection } from './types';

const TOOL_DISPLAY_RESOLVERS: Record<string, ToolDisplayResolver> = {
  [TASK_LIST_TOOL_NAME]: taskListToolDisplay,
  read_file: readFileToolDisplay,
  shell: shellToolDisplay,
  bash: shellToolDisplay
};

export function resolveToolDisplay(context: ToolDisplayContext): ToolDisplayResult {
  const fallback = defaultToolDisplay(context);
  const custom = TOOL_DISPLAY_RESOLVERS[context.toolName]?.(context);

  return {
    inputSections: custom?.inputSections ?? fallback.inputSections,
    outputSections: custom?.outputSections ?? fallback.outputSections
  };
}

function defaultToolDisplay(context: ToolDisplayContext): ToolDisplayResult {
  const inputText = context.stringifyValue(context.args).trim();
  const inputSections: ToolDisplaySection[] = inputText && inputText !== '{}'
    ? [{ kind: 'input', title: '输入', text: inputText }]
    : [];

  const outputSections: ToolDisplaySection[] = [];
  if (context.result !== undefined) {
    outputSections.push({ kind: 'output', title: '输出', text: context.stringifyValue(context.result) });
  } else if (context.progress !== undefined) {
    outputSections.push({ kind: 'output', title: '输出', text: context.stringifyValue(context.progress) });
  } else {
    const eventText = defaultEventText(context);
    if (eventText) outputSections.push({ kind: 'output', title: '事件', text: eventText });
  }

  return { inputSections, outputSections };
}

function defaultEventText(context: ToolDisplayContext): string {
  return context.events
    .map((event) => event.delta ?? (event.payload !== undefined ? context.stringifyValue(event.payload) : ''))
    .filter(Boolean)
    .join('');
}

export type { ToolDisplayContext, ToolDisplayResult, ToolDisplaySection } from './types';
