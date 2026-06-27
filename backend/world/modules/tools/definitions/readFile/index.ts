import { READ_TOOL_NAME, type InlineDataPart } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';

interface ReadFileArgs {
  path?: string;
  startLine?: number;
  endLine?: number;
  mode?: 'auto' | 'text' | 'inlineData';
  mimeType?: string;
}

const READ_INLINE_DATA_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain']);

export const readFileToolModule = defineToolDefinitionModule({
  id: READ_TOOL_NAME,
  create() {
    return readFileTool;
  }
});

export const readFileTool: ToolDefinition = {
  declaration: {
    name: READ_TOOL_NAME,
    description: [
      'Read a file from the current work environment. By default it reads UTF-8 text with optional 1-based inclusive startLine/endLine. For static images/PDF/plain text, use mode="inlineData" and provide mimeType; the file is returned as a multimodal tool response part.',
      filePathPolicyDescription(true)
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy.' },
        startLine: { type: 'number', description: '1-based start line (inclusive).' },
        endLine: { type: 'number', description: '1-based end line (inclusive).' },
        mode: { type: 'string', enum: ['auto', 'text', 'inlineData'], description: 'Read mode. Use inlineData for image/png, image/jpeg, image/webp, application/pdf, or text/plain multimodal responses.' },
        mimeType: { type: 'string', description: 'MIME type maintained by the caller. Required for mode="inlineData"; this tool does not infer or rewrite it.' }
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
    },
    configSchema: { fields: [allowOutsideProjectPathsField(true)] },
    defaultConfig: allowOutsideProjectPathsDefaultConfig(true)
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_file_read'),
  summary: summarizeReadFileToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as ReadFileArgs;
    if (!args.path) {
      return { ok: false, output: 'Missing required argument: path' };
    }
    const mode = normalizeMode(args.mode, args.startLine, args.endLine);
    if (mode === 'inlineData') {
      const mimeType = normalizeMimeType(args.mimeType);
      if (!mimeType) return { ok: false, output: 'mode="inlineData" requires mimeType.' };
      if (!READ_INLINE_DATA_MIME_TYPES.has(mimeType)) {
        return { ok: false, output: `Unsupported inlineData MIME type for read: ${mimeType}` };
      }
      const file = await deps.fs.readBinaryFile(args.path, mimeType, {
        workEnvironment: ctx?.workEnvironment,
        allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true)
      });
      const part: InlineDataPart = {
        inlineData: {
          mimeType,
          data: file.data,
          name: file.name,
          sourcePath: file.path,
          storage: 'embedded',
          status: 'available',
          sizeBytes: file.sizeBytes
        }
      };
      return { ok: true, output: { path: file.path, name: file.name, mimeType, sizeBytes: file.sizeBytes }, parts: [part] };
    }
    const text = await deps.fs.readFile(args.path, args.startLine, args.endLine, {
      workEnvironment: ctx?.workEnvironment,
      allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true)
    });
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

function normalizeMode(mode: ReadFileArgs['mode'], startLine: number | undefined, endLine: number | undefined): 'text' | 'inlineData' {
  if (startLine !== undefined || endLine !== undefined) return 'text';
  return mode === 'inlineData' ? 'inlineData' : 'text';
}

function normalizeMimeType(value: string | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
