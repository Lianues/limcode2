import type { ToolCallEventRecord } from '@shared/protocol';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';

interface ShellArgs {
  command?: string;
  cwd?: string;
  timeout?: number;
  force?: boolean;
  scheduling?: string;
}

interface ShellResultOutput {
  command?: string;
  exitCode?: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

export const shellToolDisplay: ToolDisplayResolver = (context) => {
  return {
    inputSections: shellInputSections(shellArgs(context.args), context),
    outputSections: shellOutputSections(context)
  };
};

function shellInputSections(args: ShellArgs, context: ToolDisplayContext): ToolDisplaySection[] {
  const sections: ToolDisplaySection[] = [];
  const command = args.command?.trim();
  if (command) sections.push({ kind: 'input', title: '命令', text: command });

  const optionLines = [
    args.cwd?.trim() ? `cwd ${args.cwd.trim()}` : undefined,
    typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? `timeout ${args.timeout}ms` : undefined,
    typeof args.force === 'boolean' ? `force ${args.force}` : undefined,
    args.scheduling?.trim() ? `scheduling ${args.scheduling.trim()}` : undefined
  ].filter((line): line is string => Boolean(line));
  if (optionLines.length > 0) sections.push({ kind: 'input', title: '参数', text: optionLines.join('\n') });

  if (sections.length === 0) sections.push({ kind: 'input', title: '输入', text: context.stringifyValue(context.args) });
  return sections;
}

function shellOutputSections(context: ToolDisplayContext): ToolDisplaySection[] {
  const output = resultOutput(context.result);
  const stdout = streamText(context.events, 'stdout') || output?.stdout || '';
  const stderr = streamText(context.events, 'stderr') || output?.stderr || '';
  const progress = progressText(context);
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

function shellArgs(value: unknown): ShellArgs {
  const record = asRecord(value);
  if (!record) return {};
  return {
    command: stringValue(record.command),
    cwd: stringValue(record.cwd),
    timeout: numberValue(record.timeout),
    force: booleanValue(record.force),
    scheduling: stringValue(record.scheduling)
  };
}

function resultOutput(result: unknown): ShellResultOutput | undefined {
  const resultRecord = asRecord(result);
  const output = resultRecord && 'output' in resultRecord ? resultRecord.output : result;
  if (typeof output === 'string') return parseStringOutput(output);
  const outputRecord = asRecord(output);
  return outputRecord ? shellResultOutput(outputRecord) : undefined;
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
    stderr: stringValue(record.stderr)
  };
}

function streamText(events: readonly ToolCallEventRecord[], kind: 'stdout' | 'stderr'): string {
  return events
    .filter((event) => event.kind === kind && typeof event.delta === 'string')
    .map((event) => event.delta)
    .join('');
}

function progressText(context: ToolDisplayContext): string {
  const progressEvents = context.events
    .filter((event) => event.kind === 'progress' && event.payload !== undefined)
    .map((event) => context.stringifyValue(event.payload));
  return progressEvents.join('\n');
}

function shellExitInfo(output: ShellResultOutput | undefined): string {
  if (!output) return '';
  const lines = [
    typeof output.exitCode === 'number' ? `exitCode ${output.exitCode}` : undefined,
    typeof output.killed === 'boolean' ? `killed ${output.killed}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
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
