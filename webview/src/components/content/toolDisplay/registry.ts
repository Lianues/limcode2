import type { Component } from 'vue';
import {
  IconFileDescription,
  IconMessageDots,
  IconPencil,
  IconPlaylistAdd,
  IconSwitch,
  IconTerminal2,
  IconTool,
  IconTransfer,
  IconUsers,
  IconWriting
} from '@tabler/icons-vue';
import { EDIT_TOOL_NAME, READ_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TASK_LIST_TOOL_NAME, TRANSFER_FILES_TOOL_NAME, WRITE_TOOL_NAME } from '@shared/protocol';
import { editToolDisplay, writeToolDisplay } from './fileChangeToolDisplay';
import { readConversationToolDisplay } from './readConversationToolDisplay';
import { readFileToolDisplay } from './readFileToolDisplay';
import { runAgentToolDisplay } from './runAgentToolDisplay';
import { shellToolDisplay } from './shellToolDisplay';
import { switchWorkEnvironmentToolDisplay } from './switchWorkEnvironmentToolDisplay';
import { taskListToolDisplay } from './taskListToolDisplay';
import { transferFilesToolDisplay } from './transferFilesToolDisplay';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplayResult, ToolDisplaySection } from './types';

const TOOL_DISPLAY_RESOLVERS: Record<string, ToolDisplayResolver> = {
  [TASK_LIST_TOOL_NAME]: taskListToolDisplay,
  [READ_TOOL_NAME]: readFileToolDisplay,
  [EDIT_TOOL_NAME]: editToolDisplay,
  [WRITE_TOOL_NAME]: writeToolDisplay,
  read_conversation: readConversationToolDisplay,
  run_agent: runAgentToolDisplay,
  shell: shellToolDisplay,
  bash: shellToolDisplay,
  [SWITCH_WORK_ENVIRONMENT_TOOL_NAME]: switchWorkEnvironmentToolDisplay,
  [TRANSFER_FILES_TOOL_NAME]: transferFilesToolDisplay
};

const TOOL_HEADER_ICONS: Record<string, Component> = {
  [TASK_LIST_TOOL_NAME]: IconPlaylistAdd,
  [READ_TOOL_NAME]: IconFileDescription,
  [EDIT_TOOL_NAME]: IconPencil,
  [WRITE_TOOL_NAME]: IconWriting,
  read_conversation: IconMessageDots,
  run_agent: IconUsers,
  shell: IconTerminal2,
  bash: IconTerminal2,
  [SWITCH_WORK_ENVIRONMENT_TOOL_NAME]: IconSwitch,
  [TRANSFER_FILES_TOOL_NAME]: IconTransfer
};

export function resolveToolHeaderIcon(toolName: string): Component {
  return TOOL_HEADER_ICONS[toolName] ?? IconTool;
}

export function resolveToolDisplay(context: ToolDisplayContext): ToolDisplayResult {
  const fallback = defaultToolDisplay(context);
  const custom = TOOL_DISPLAY_RESOLVERS[context.toolName]?.(context);

  return {
    inputSections: custom?.inputSections ?? fallback.inputSections,
    outputSections: custom?.outputSections ?? fallback.outputSections,
    headerIcon: custom?.headerIcon ?? fallback.headerIcon ?? resolveToolHeaderIcon(context.toolName),
    headerActions: custom?.headerActions ?? fallback.headerActions
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

  return { inputSections, outputSections, headerActions: [] };
}

function defaultEventText(context: ToolDisplayContext): string {
  return context.events
    .map((event) => event.delta ?? (event.payload !== undefined ? context.stringifyValue(event.payload) : ''))
    .filter(Boolean)
    .join('');
}

export type { ToolDisplayContext, ToolDisplayResult, ToolDisplaySection, ToolHeaderAction } from './types';
