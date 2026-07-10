import { READ_TOOL_NAME, type InlineDataPart } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';

type ReadFileMode = 'text' | 'attachment';

interface ReadFileArgs {
  path?: string;
  mode?: ReadFileMode;
  startLine?: number;
  endLine?: number;
}

const READ_MULTIMODAL_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
const EXTENSION_MIME_MAP: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };

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
      'Read a file from the current work environment. The optional mode defaults to "text", which reads UTF-8 text with optional 1-based inclusive startLine/endLine. Use mode="attachment" for supported images (png/jpg/jpeg/webp) and PDF; the MIME type is inferred from the file extension and the file is returned as a multimodal inlineData tool response part. Attachment mode ignores startLine/endLine.',
      filePathPolicyDescription(true)
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy or when they are inside an explicitly allowed local work environment root.' },
        mode: { type: 'string', enum: ['text', 'attachment'], description: 'Optional read mode. Defaults to "text" when omitted; use "attachment" for a multimodal file inferred from its extension.' },
        startLine: { type: 'number', description: 'Text mode only. Optional 1-based start line (inclusive); non-positive values are treated as omitted.' },
        endLine: { type: 'number', description: 'Text mode only. Optional 1-based end line (inclusive); non-positive values are treated as omitted.' }
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
    const explicitMode = normalizeReadMode(args.mode);
    if (args.mode !== undefined && !explicitMode) {
      return { ok: false, output: 'Invalid argument: mode. Expected "text" or "attachment".' };
    }
    const mode: ReadFileMode = explicitMode ?? 'text';

    const mimeType = inferMimeType(args.path);
    const isSupportedAttachment = !!mimeType && READ_MULTIMODAL_MIME_TYPES.has(mimeType);
    if (mode === 'attachment') {
      if (!isSupportedAttachment || !mimeType) {
        return { ok: false, output: unsupportedAttachmentMessage(args.path) };
      }
      if (ctx?.settingsSnapshot?.enableMultimodalTools === false) {
        return { ok: true, status: 'warning', output: multimodalDisabledMessage(mimeType) };
      }
      const file = await deps.fs.readBinaryFile(args.path, mimeType, {
        workEnvironment: ctx?.workEnvironment,
        accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
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
      return { ok: true, output: { mimeType, sizeBytes: file.sizeBytes }, parts: [part] };
    }

    if (isSupportedAttachment) {
      return { ok: false, output: `Cannot read ${mimeType} as UTF-8 text. Use mode="attachment" for ${args.path}.` };
    }
    const text = await deps.fs.readFile(args.path, normalizeLineNumber(args.startLine), normalizeLineNumber(args.endLine), {
      workEnvironment: ctx?.workEnvironment,
      accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
      allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true)
    });
    return { ok: true, output: text };
  }
};

function summarizeReadFileToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as ReadFileArgs;
  const path = normalizeDisplayPath(args.path);
  if (!path) return undefined;

  const mode = normalizeReadMode(args.mode) ?? 'text';
  const modeSuffix = `[${mode}]`;
  if (mode === 'attachment') return `${path}${modeSuffix}`;
  const range = lineRangeSuffix(args.startLine, args.endLine);
  return `${path}${modeSuffix}${range}`;
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

function normalizeReadMode(value: unknown): ReadFileMode | undefined {
  return value === 'text' || value === 'attachment' ? value : undefined;
}

function multimodalDisabledMessage(mimeType: string): string {
  return `当前渠道未启用多模态工具，模型不具备读取 ${mimeType} 附件内容的能力。read 现在只能读取文本文件；如需查看图片、PDF 等附件，请在渠道配置中启用多模态工具。`;
}

function unsupportedAttachmentMessage(filePath: string): string {
  return `mode="attachment" only supports .png, .jpg, .jpeg, .webp, and .pdf files. Unsupported path: ${filePath}`;
}

function inferMimeType(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_MIME_MAP[filePath.slice(dot).toLowerCase()];
}
