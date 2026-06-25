import { EDIT_TOOL_NAME, type EditToolMode } from '../../../../../../shared/protocol';
import type { FsStructuredEditHunk, FsInsertEditRequest, FsDeleteEditRequest, FsEditFileRequest } from '../../../../../capabilities/types';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolDefinition, ToolDeps } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';

interface EditArgs {
  path?: string;
  patch?: string;
  hunks?: unknown;
  insert?: { line?: number; content?: string };
  delete?: { startLine?: number; endLine?: number };
}

export const EDIT_TOOL_MODE_DEFAULT: EditToolMode = 'hunk';

export const editToolModule = defineToolDefinitionModule({
  id: EDIT_TOOL_NAME,
  create() {
    return editTool;
  }
});

export const editTool: ToolDefinition = {
  declaration: {
    name: EDIT_TOOL_NAME,
    description: hunkModeDescription(),
    parameters: hunkModeParameters(),
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: true,
      defaultAutoExpand: true,
      defaultAutoApproveExecution: false,
      requiresApproval: true,
      checkpoint: { before: true, after: true }
    },
    configSchema: {
      fields: [
        {
          key: 'mode',
          label: '编辑模式',
          type: 'enum',
          description: '选择 edit 工具暴露给 AI 的参数格式与内部兜底策略。hunk=结构化 oldContent/newContent；patch=unified diff patch。',
          defaultValue: EDIT_TOOL_MODE_DEFAULT,
          options: [
            { label: 'Hunk 结构化模式', value: 'hunk', description: '使用 hunks[{ oldContent, newContent, startLine? }]，含唯一匹配、行号定位与缩进兜底。' },
            { label: 'Patch 模式', value: 'patch', description: '使用 unified diff patch 字符串，含 hunk 行号、上下文搜索、search/replace 与 loose @@ 兜底。' }
          ]
        },
        allowOutsideProjectPathsField(false)
      ]
    },
    defaultConfig: { mode: EDIT_TOOL_MODE_DEFAULT, ...allowOutsideProjectPathsDefaultConfig(false) }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'filesystem_edit_side_effect'),
  summary: summarizeEditToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as EditArgs;
    const runtimeMode = detectEditMode(args, ctx?.config);
    const path = normalizeDisplayPath(args.path);
    if (!path) return { ok: false, output: await failedOutput(deps, runtimeMode, path, 'Missing required argument: path') };

    try {
      const request = buildEditRequest(path, args, runtimeMode);
      const result = await deps.fs.editFile(request, {
        workEnvironment: ctx?.workEnvironment,
        allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, false)
      });
      await recordStatistics(deps, runtimeMode, result.success);
      return { ok: result.success, output: result, ...(result.failed > 0 ? { status: 'warning' as const } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: await failedOutput(deps, runtimeMode, path, message) };
    }
  }
};

export function editModeFromConfig(config: ToolConfigRecord | undefined): EditToolMode {
  return config?.mode === 'patch' ? 'patch' : 'hunk';
}

export function hunkModeDescription(): string {
  return [
    'Modify one UTF-8 text file using structured hunks.',
    'This mode accepts hunks[{ oldContent, newContent, startLine? }]. Each hunk replaces one exact oldContent block with newContent.',
    'Fallback strategy: if oldContent is unique it is replaced directly; if repeated, startLine is used after accounting for prior hunk line offsets; if exact matching fails, a conservative leading-indentation-only fallback is attempted and replacement indentation is remapped.',
    'Use multiple hunks in one call for multiple independent edits in the same file. For new files or full rewrites, use write.',
    filePathPolicyDescription(false)
  ].join('\n');
}

export function hunkModeParameters(): unknown {
  return {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy.' },
      hunks: {
        type: 'array',
        description: 'Ordered edit hunks. Each hunk replaces oldContent with newContent. Use startLine only to disambiguate repeated oldContent.',
        items: {
          type: 'object',
          properties: {
            oldContent: { type: 'string', description: 'Existing file text to replace. Include enough context so it is unique whenever possible.' },
            newContent: { type: 'string', description: 'Replacement text exactly as it should appear in the final file.' },
            startLine: { type: 'number', description: 'Optional 1-based line hint from the original file, used only when oldContent has multiple matches.' }
          },
          required: ['oldContent', 'newContent']
        }
      }
    },
    required: ['path', 'hunks']
  };
}

export function patchModeDescription(): string {
  return [
    'Modify one UTF-8 text file using a unified diff patch string.',
    'This mode accepts { path, patch }. The patch may include ---/+++ headers and one or more @@ -oldStart,oldCount +newStart,newCount @@ hunks for this single file.',
    'Fallback strategy: each hunk first applies by line number; if that fails, the context+deleted block is searched globally and applied only when unique. If some hunks still fail, hunks are converted to search/replace blocks and retried. Bare @@ hunks without line numbers are parsed with a loose search/replace fallback.',
    'Do not include multi-file patches or /dev/null create/delete patches. Use write for new files and delete for deleting files/directories.',
    filePathPolicyDescription(false)
  ].join('\n');
}

export function patchModeParameters(): unknown {
  return {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy.' },
      patch: {
        type: 'string',
        description: 'Unified diff patch for this single file. Hunk lines use prefix space=context, -=delete, +=add. Bare @@ hunks are allowed as a loose fallback when enough context is present.'
      }
    },
    required: ['path', 'patch']
  };
}

export function insertDeleteDescription(): string {
  return [
    '\nLine-based methods (always available, choose per call):',
    '- insert: provide insert={ line, content } to insert text before the given 1-based line number. Use line N+1 to append after the last line.',
    '- delete: provide delete={ startLine, endLine } to remove lines in the inclusive range [startLine, endLine].'
  ].join('\n');
}

export function insertModeParameters(): unknown {
  return {
    type: 'object',
    properties: {
      line: { type: 'number', description: '1-based line number before which to insert content. Use line N+1 to append after the last line of the file.' },
      content: { type: 'string', description: 'Text to insert at the specified line position. May contain multiple lines separated by newlines.' }
    },
    required: ['line', 'content']
  };
}

export function deleteModeParameters(): unknown {
  return {
    type: 'object',
    properties: {
      startLine: { type: 'number', description: '1-based first line to delete (inclusive).' },
      endLine: { type: 'number', description: '1-based last line to delete (inclusive).' }
    },
    required: ['startLine', 'endLine']
  };
}


function buildPatchModeRequest(path: string, args: EditArgs): { path: string; mode: 'patch'; patch: string } {
  if (typeof args.patch !== 'string' || args.patch.trim().length === 0) throw new Error('Missing required argument for patch mode: patch');
  return { path, mode: 'patch', patch: args.patch };
}

function buildHunkModeRequest(path: string, args: EditArgs): { path: string; mode: 'hunk'; hunks: FsStructuredEditHunk[] } {
  const hunks = normalizeStructuredHunks(args.hunks);
  if (hunks.length === 0) throw new Error('Missing required argument for hunk mode: hunks');
  return { path, mode: 'hunk', hunks };
}

function detectEditMode(args: EditArgs, config: ToolConfigRecord | undefined): EditToolMode {
  if (args.insert && typeof args.insert.line === 'number' && typeof args.insert.content === 'string') return 'insert';
  if (args.delete && typeof args.delete.startLine === 'number' && typeof args.delete.endLine === 'number') return 'delete';
  return editModeFromConfig(config);
}

function buildEditRequest(path: string, args: EditArgs, mode: EditToolMode): FsEditFileRequest {
  if (mode === 'insert') return buildInsertModeRequest(path, args);
  if (mode === 'delete') return buildDeleteModeRequest(path, args);
  if (mode === 'patch') return buildPatchModeRequest(path, args);
  return buildHunkModeRequest(path, args);
}

function buildInsertModeRequest(path: string, args: EditArgs): { path: string; mode: 'insert'; insert: FsInsertEditRequest } {
  if (!args.insert || typeof args.insert.line !== 'number' || typeof args.insert.content !== 'string') {
    throw new Error('Missing required arguments for insert mode: insert.line and insert.content');
  }
  return { path, mode: 'insert', insert: { line: Math.max(1, Math.floor(args.insert.line)), content: args.insert.content } };
}

function buildDeleteModeRequest(path: string, args: EditArgs): { path: string; mode: 'delete'; delete: FsDeleteEditRequest } {
  if (!args.delete || typeof args.delete.startLine !== 'number' || typeof args.delete.endLine !== 'number') {
    throw new Error('Missing required arguments for delete mode: delete.startLine and delete.endLine');
  }
  return { path, mode: 'delete', delete: { startLine: Math.max(1, Math.floor(args.delete.startLine)), endLine: Math.max(1, Math.floor(args.delete.endLine)) } };
}


function normalizeStructuredHunks(value: unknown): FsStructuredEditHunk[] {
  if (!Array.isArray(value)) return [];
  const result: FsStructuredEditHunk[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record.oldContent !== 'string' || typeof record.newContent !== 'string') continue;
    result.push({
      oldContent: record.oldContent,
      newContent: record.newContent,
      ...(typeof record.startLine === 'number' && Number.isFinite(record.startLine) ? { startLine: Math.max(1, Math.floor(record.startLine)) } : {})
    });
  }
  return result;
}

async function failedOutput(deps: ToolDeps, mode: EditToolMode, path: string, error: string): Promise<Record<string, unknown>> {
  await recordStatistics(deps, mode, false);
  return {
    kind: 'file_edit.result',
    mode,
    path,
    success: false,
    error,
    summary: `edit(${mode}) failed: ${error}`
  };
}

async function recordStatistics(deps: ToolDeps, mode: EditToolMode, success: boolean): Promise<void> {
  try {
    await deps.storage.recordEditToolModeResult(mode, success);
  } catch (error) {
    console.warn('[LimCode] Failed to record edit tool mode statistics.', error);
  }
}

function summarizeEditToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as EditArgs;
  const path = normalizeDisplayPath(args.path);
  return path ? `edit ${path}` : undefined;
}

function normalizeDisplayPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
