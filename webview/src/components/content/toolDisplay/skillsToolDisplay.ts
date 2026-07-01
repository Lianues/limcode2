import { IconBook } from '@tabler/icons-vue';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';

interface SkillsArgs {
  name?: string;
}

interface SkillsOutputRecord {
  entryPath?: string;
  body?: string;
}

export const skillsToolDisplay: ToolDisplayResolver = (context) => {
  const args = skillsArgs(context.args);
  const inputSections = skillsInputSections(args);
  const outputSections = skillsOutputSections(context);

  return {
    headerIcon: IconBook,
    ...(inputSections ? { inputSections } : {}),
    ...(outputSections ? { outputSections } : {})
  };
};

function skillsInputSections(args: SkillsArgs): ToolDisplaySection[] | undefined {
  const name = args.name?.trim();
  if (!name) return undefined;
  return [{ kind: 'input', title: '载入技能', rows: [{ label: 'name', value: name }], rowStyle: 'keyValue' }];
}

function skillsOutputSections(context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  if (context.result === undefined) return undefined;

  const output = toolOutput(context.result);

  if (typeof output === 'string') {
    return output ? [{ kind: 'output', title: '技能内容', text: output }] : undefined;
  }

  const record = outputRecord(output);
  if (!record) return undefined;

  const path = normalizePath(record.entryPath);
  const title = path ? `技能内容 · ${path}` : '技能内容';

  if (typeof record.body === 'string' && record.body.trim()) {
    return [{ kind: 'output', title, text: record.body, markdown: true }];
  }
  return undefined;
}

function skillsArgs(value: unknown): SkillsArgs {
  const record = asRecord(value);
  return record ? { name: stringValue(record.name) } : {};
}

function toolOutput(result: unknown): unknown {
  const record = asRecord(result);
  return record && 'output' in record ? record.output : result;
}

function outputRecord(value: unknown): SkillsOutputRecord | undefined {
  const record = asRecord(value);
  return record ? record as SkillsOutputRecord : undefined;
}

function normalizePath(path: string | undefined): string {
  return path?.trim().replace(/\\+/g, '/') ?? '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
