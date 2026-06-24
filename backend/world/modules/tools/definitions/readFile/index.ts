import { READ_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

interface ReadFileArgs {
  path?: string;
  startLine?: number;
  endLine?: number;
}

export const readFileToolModule = defineToolDefinitionModule({
  id: READ_TOOL_NAME,
  create() {
    return readFileTool;
  }
});

export const readFileTool: ToolDefinition = {
  declaration: {
    name: READ_TOOL_NAME,
    description: 'Read a UTF-8 text file from the current work environment. Optional startLine/endLine are 1-based and inclusive.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        startLine: { type: 'number', description: '1-based start line (inclusive).' },
        endLine: { type: 'number', description: '1-based end line (inclusive).' }
      },
      required: ['path']
    },
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_file_read'),
  summary: summarizeReadFileToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as ReadFileArgs;
    if (!args.path) {
      return { ok: false, output: 'Missing required argument: path' };
    }
    const text = await deps.fs.readFile(args.path, args.startLine, args.endLine, { workEnvironment: ctx?.workEnvironment });
    return { ok: true, output: text };
  }
};

function summarizeReadFileToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as ReadFileArgs;
  const path = normalizeDisplayPath(args.path);
  if (!path) return undefined;

  const range = lineRangeSuffix(args.startLine, args.endLine);
  return range ? `${path}${range}` : path;
}

function normalizeDisplayPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}

function lineRangeSuffix(startLine: number | undefined, endLine: number | undefined): string {
  const start = normalizeLineNumber(startLine);
  const end = normalizeLineNumber(endLine);
  if (start !== undefined && end !== undefined) return `[L${start}-${end}]`;
  if (start !== undefined) return `[L${start}-]`;
  if (end !== undefined) return `[L1-${end}]`;
  return '';
}

function normalizeLineNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const line = Math.floor(value);
  return line > 0 ? line : undefined;
}
