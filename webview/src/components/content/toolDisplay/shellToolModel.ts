import type { ToolCallEventRecord } from '@shared/protocol';
import type { ToolDisplayContext, ToolDisplaySection } from './types';

export interface ShellArgs {
  command?: string;
  cwd?: string;
  foregroundWaitMs?: number;
  force?: boolean;
  scheduling?: string;
  explanation?: string;
  mode?: string;
  processId?: string;
  readonly?: string;
  wait?: string;
}

export interface ShellResultOutput {
  command?: string;
  exitCode?: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  status?: string;
  processId?: string;
  running?: boolean;
  droppedChars?: number;
}

export function parseShellArgs(value: unknown): ShellArgs {
  const record = asRecord(value);
  if (!record) return {};
  return {
    command: stringValue(record.command),
    cwd: stringValue(record.cwd),
    foregroundWaitMs: numberValue(record.foregroundWaitMs),
    force: booleanValue(record.force),
    scheduling: stringValue(record.scheduling),
    explanation: stringValue(record.explanation),
    mode: stringValue(record.mode),
    processId: stringValue(record.processId),
    readonly: stringValue(record.readonly),
    wait: stringValue(record.wait)
  };
}

export function parseShellCallArgs(argsJson: string): ShellArgs {
  if (!argsJson.trim()) return {};
  try {
    return parseShellArgs(JSON.parse(argsJson));
  } catch {
    return {};
  }
}

export function parseShellResultOutput(result: unknown): ShellResultOutput | undefined {
  const resultRecord = asRecord(result);
  const output = resultRecord && 'output' in resultRecord ? resultRecord.output : result;
  if (typeof output === 'string') return parseStringOutput(output);
  const outputRecord = asRecord(output);
  return outputRecord ? shellResultOutput(outputRecord) : undefined;
}

export function shellInputSections(args: ShellArgs, context: ToolDisplayContext): ToolDisplaySection[] {
  const sections: ToolDisplaySection[] = [];
  const explanation = args.explanation?.trim();
  if (explanation) sections.push({ kind: 'input', title: '说明', text: explanation });
  const command = args.command?.trim();
  if (command) sections.push({ kind: 'input', title: '命令', text: command });

  const optionLines = [
    args.cwd?.trim() ? `cwd ${args.cwd.trim()}` : undefined,
    typeof args.foregroundWaitMs === 'number' && Number.isFinite(args.foregroundWaitMs) ? `前台等待预算 ${args.foregroundWaitMs}ms` : undefined,
    typeof args.force === 'boolean' ? `force ${args.force}` : undefined,
    args.scheduling?.trim() ? `scheduling ${args.scheduling.trim()}` : undefined
  ].filter((line): line is string => Boolean(line));
  if (optionLines.length > 0) sections.push({ kind: 'input', title: '参数', text: optionLines.join('\n') });

  if (sections.length === 0) sections.push({ kind: 'input', title: '输入', text: context.stringifyValue(context.args) });
  return sections;
}

export function shellOutputSections(context: ToolDisplayContext): ToolDisplaySection[] {
  const output = parseShellResultOutput(context.result);
  const stdout = shellStreamText(context.events, 'stdout') || output?.stdout || '';
  const stderr = shellStreamText(context.events, 'stderr') || output?.stderr || '';
  const progress = shellProgressText(context.events, context.stringifyValue);
  const sections: ToolDisplaySection[] = [];

  if (stdout) sections.push({ kind: 'output', title: 'stdout', text: stdout });
  if (stderr) sections.push({ kind: 'output', title: 'stderr', text: stderr });
  if (progress) sections.push({ kind: 'output', title: '过程', text: progress });

  const exitInfo = shellExitInfo(output);
  if (exitInfo) sections.push({ kind: 'output', title: '执行信息', text: exitInfo });

  if (sections.length === 0 && context.result !== undefined) {
    sections.push({ kind: 'output', title: '输出', text: context.stringifyValue(context.result) });
  }

  return sections;
}

export function shellStreamText(events: readonly ToolCallEventRecord[], kind: 'stdout' | 'stderr'): string {
  return events
    .filter((event) => event.kind === kind && typeof event.delta === 'string')
    .map((event) => event.delta)
    .join('');
}

export function shellProgressText(events: readonly ToolCallEventRecord[], stringifyValue: (value: unknown) => string): string {
  const progressEvents = events
    .filter((event) => event.kind === 'progress' && event.payload !== undefined)
    .map((event) => stringifyValue(event.payload));
  return progressEvents.join('\n');
}

export function shellExitInfo(output: ShellResultOutput | undefined): string {
  if (!output) return '';
  const lines = [
    output.status ? `status ${output.status}` : undefined,
    output.processId ? `processId ${output.processId}` : undefined,
    typeof output.running === 'boolean' ? `running ${output.running}` : undefined,
    typeof output.exitCode === 'number' ? `exitCode ${output.exitCode}` : undefined,
    typeof output.killed === 'boolean' ? `killed ${output.killed}` : undefined,
    typeof output.droppedChars === 'number' && output.droppedChars > 0 ? `droppedChars ${output.droppedChars}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function parseStringOutput(output: string): ShellResultOutput | undefined {
  const text = output.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    const record = asRecord(parsed);
    return record ? shellResultOutput(record) : undefined;
  } catch {
    return { stdout: output };
  }
}

function shellResultOutput(record: Record<string, unknown>): ShellResultOutput {
  return {
    command: stringValue(record.command),
    exitCode: numberValue(record.exitCode),
    killed: booleanValue(record.killed),
    stdout: stringValue(record.stdout),
    stderr: stringValue(record.stderr),
    status: stringValue(record.status),
    processId: stringValue(record.processId),
    running: booleanValue(record.running),
    droppedChars: numberValue(record.droppedChars)
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
