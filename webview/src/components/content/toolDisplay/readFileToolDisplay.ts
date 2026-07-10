import { IconFileDescription } from '@tabler/icons-vue';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';

type ReadFileMode = 'text' | 'attachment';

interface ReadFileArgs {
  path?: string;
  mode?: ReadFileMode;
  startLine?: number;
  endLine?: number;
}

interface ReadFileLineRecord {
  line?: number;
  text?: string;
}

interface ReadFileOutputRecord {
  path?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  lines?: unknown;
  content?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
}

export const readFileToolDisplay: ToolDisplayResolver = (context) => {
  const args = readFileArgs(context.args);
  const inputSections = readFileInputSections(args, context);
  const outputSections = readFileOutputSections(args, context);

  return {
    headerIcon: IconFileDescription,
    ...(inputSections ? { inputSections } : {}),
    ...(outputSections ? { outputSections } : {})
  };
};

function readFileInputSections(args: ReadFileArgs, context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  const path = normalizePath(args.path);
  if (!path) return undefined;

  const rows = parameterRows([
    { label: 'path', value: path },
    { label: 'mode', value: args.mode ?? 'text' },
    { label: 'lines', value: args.mode === 'attachment' ? undefined : lineRangeText(args.startLine, args.endLine) }
  ]);

  return rows.length > 0
    ? [{ kind: 'input', title: '读取参数', rows, rowStyle: 'keyValue' }]
    : [{ kind: 'input', title: '输入', text: context.stringifyValue(context.args) }];
}

function readFileOutputSections(args: ReadFileArgs, context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  if (context.result === undefined) return undefined;

  const output = toolOutput(context.result);
  const record = outputRecord(output);
  const path = normalizePath(record?.path) || normalizePath(args.path);
  const mode: ReadFileMode = attachmentOutput(record) ? 'attachment' : args.mode ?? 'text';
  const modeSuffix = `[${mode}]`;
  const rangeSuffix = mode === 'attachment'
    ? ''
    : lineRangeSuffix(record?.startLine ?? args.startLine, record?.endLine ?? args.endLine);
  const title = path
    ? `读取结果 · ${path}${modeSuffix}${rangeSuffix}`
    : '读取结果';

  const section = readFileOutputSection(title, output);
  if (!section) return undefined;

  return [section];
}

function readFileArgs(value: unknown): ReadFileArgs {
  const record = asRecord(value);
  if (!record) return {};
  return {
    path: stringValue(record.path),
    mode: readFileMode(record.mode),
    startLine: numberValue(record.startLine),
    endLine: numberValue(record.endLine)
  };
}

function toolOutput(result: unknown): unknown {
  const record = asRecord(result);
  return record && 'output' in record ? record.output : result;
}

function readFileOutputSection(title: string, output: unknown): ToolDisplaySection | undefined {
  if (typeof output === 'string') return output ? { kind: 'output', title, text: output } : undefined;

  const record = outputRecord(output);
  if (!record) return undefined;

  const lines = lineRecords(record.lines);
  if (lines.length > 0) return { kind: 'output', title, rows: readLineRows(lines), rowStyle: 'lineNumber' };

  if (attachmentOutput(record)) {
    const rows = parameterRows([
      { label: 'mimeType', value: stringValue(record.mimeType) },
      { label: 'size', value: attachmentSizeText(record.sizeBytes) }
    ]);
    return rows.length > 0 ? { kind: 'output', title, rows, rowStyle: 'keyValue' } : undefined;
  }

  return typeof record.content === 'string' ? { kind: 'output', title, text: record.content } : undefined;
}

function outputRecord(value: unknown): ReadFileOutputRecord | undefined {
  const record = asRecord(value);
  return record ? record as ReadFileOutputRecord : undefined;
}

function lineRecords(value: unknown): ReadFileLineRecord[] {
  if (!Array.isArray(value)) return [];
  const lines: ReadFileLineRecord[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const line = numberValue(record?.line);
    if (line === undefined) continue;
    const text = typeof record?.text === 'string' ? record.text : '';
    lines.push({ line, text });
  }
  return lines;
}

function parameterRows(items: Array<{ label: string; value: string | undefined }>): Array<{ label: string; value: string }> {
  return items.filter((item): item is { label: string; value: string } => Boolean(item.value));
}

function readLineRows(lines: ReadFileLineRecord[]): Array<{ label: string; value: string }> {
  return lines
    .filter((line): line is { line: number; text?: string } => typeof line.line === 'number')
    .map((line) => ({ label: String(line.line), value: line.text ?? '' }));
}

function lineRangeText(startLine: number | undefined, endLine: number | undefined): string | undefined {
  const suffix = lineRangeSuffix(startLine, endLine);
  return suffix ? suffix.slice(1, -1) : undefined;
}

function lineRangeSuffix(startLine: number | undefined, endLine: number | undefined): string {
  const start = normalizeLineNumber(startLine);
  const end = normalizeLineNumber(endLine);
  if (start !== undefined && end !== undefined) return `[L${start}-${end}]`;
  if (start !== undefined) return `[L${start}-]`;
  if (end !== undefined) return `[L1-${end}]`;
  return '';
}

function normalizePath(path: string | undefined): string {
  return path?.trim().replace(/\\+/g, '/') ?? '';
}

function normalizeLineNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const line = Math.floor(value);
  return line > 0 ? line : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readFileMode(value: unknown): ReadFileMode | undefined {
  return value === 'text' || value === 'attachment' ? value : undefined;
}

function attachmentOutput(record: ReadFileOutputRecord | undefined): boolean {
  return typeof record?.mimeType === 'string' && typeof record?.sizeBytes === 'number';
}

function attachmentSizeText(value: unknown): string | undefined {
  const size = numberValue(value);
  return size === undefined ? undefined : `${size} bytes`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
