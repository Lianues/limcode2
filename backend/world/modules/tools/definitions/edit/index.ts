import { EDIT_TOOL_NAME, type EditToolMode } from '../../../../../../shared/protocol';
import type { FsDeleteEditRequest, FsEditFileRequest, FsHunkEditRequest, FsInsertEditRequest } from '../../../../../capabilities/types';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';

interface EditArgs {
  path?: string;
  hunks?: unknown;
  insert?: { line?: number; content?: string };
  delete?: { startLine?: number; endLine?: number };
}

export const editToolModule = defineToolDefinitionModule({
  id: EDIT_TOOL_NAME,
  create() {
    return editTool;
  }
});

export const editTool: ToolDefinition = {
  declaration: {
    name: EDIT_TOOL_NAME,
    description: editToolDescription(),
    parameters: editToolParameters(),
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: true,
      defaultAutoExpand: true,
      defaultAutoApproveExecution: false,
      supportsChangeApply: true,
      supportsDiffPreview: true,
      defaultAutoOpenDiffPreview: false,
      defaultAutoApplyChange: true,
      defaultAutoApplyChangeDelaySeconds: 3,
      requiresApproval: true,
      checkpoint: { before: true, after: true }
    },
    configSchema: {
      fields: [allowOutsideProjectPathsField(false)]
    },
    defaultConfig: { ...allowOutsideProjectPathsDefaultConfig(false) }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'filesystem_edit_side_effect'),
  summary: summarizeEditToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as EditArgs;
    const runtimeMode = detectEditMode(args);
    const path = normalizeDisplayPath(args.path);
    if (!path) return { ok: false, output: failedOutput(runtimeMode, path, 'Missing required argument: path') };

    try {
      const request = buildEditRequest(path, args, runtimeMode);
      const result = await deps.fs.proposeEditFile(request, {
        workEnvironment: ctx?.workEnvironment,
        allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, false)
      });
      return {
        ok: result.success,
        output: result,
        ...(result.pending ? { status: 'awaiting_change_apply' as const } : result.failed > 0 ? { status: 'warning' as const } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: failedOutput(runtimeMode, path, message) };
    }
  }
};

export function editToolDescription(): string {
  return [hunkModeDescription(), insertDeleteDescription()].join('\n');
}

export function editToolParameters(): unknown {
  const base = hunkModeParameters() as { type: string; properties: Record<string, unknown>; required: string[] };
  return {
    ...base,
    properties: {
      ...base.properties,
      insert: insertModeParameters(),
      delete: deleteModeParameters()
    },
    required: ['path']
  };
}

export function hunkModeDescription(): string {
  return [
    'Modify one UTF-8 text file using hunk-style search/replace.',
    'Primary hunk arguments: { path, hunks }. hunks is an ordered array; each hunk is { oldContent, newContent, replaceAll? }.',
    'Each oldContent is matched as exact existing text against the current file after prior hunks are applied. By default only the first match is replaced for that hunk. Set hunk.replaceAll=true to replace every non-overlapping match.',
    'Use multiple hunks in one call for multiple independent edits in the same file. Use write for new files or full rewrites. Use insert/delete for line-based edits.',
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
        description: 'Ordered hunk blocks. Each hunk performs exact search/replace in this same file. Use multiple hunks to modify multiple locations in one call.',
        items: {
          type: 'object',
          properties: {
            oldContent: { type: 'string', description: 'Existing file text to find. Must be an exact substring of the current file at the time this hunk runs.' },
            newContent: { type: 'string', description: 'Replacement text exactly as it should appear in the final file. Use an empty string to remove the matched text.' },
            replaceAll: { type: 'boolean', description: 'Whether this hunk replaces every non-overlapping oldContent match. Defaults to false, replacing only the first match.' }
          },
          required: ['oldContent', 'newContent']
        }
      }
    },
    required: ['path', 'hunks']
  };
}

export function insertDeleteDescription(): string {
  return [
    '',
    'Line-based modes remain available:',
    '- insert: provide insert={ line, content } to insert text before the given 1-based line number. Use line N+1 to append after the last line.',
    '- delete: provide delete={ startLine, endLine } to remove lines in the inclusive range [startLine, endLine].',
    'When using insert or delete, hunks is not required.'
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

function detectEditMode(args: EditArgs): EditToolMode {
  if (args.insert !== undefined) return 'insert';
  if (args.delete !== undefined) return 'delete';
  return 'hunk';
}

function buildEditRequest(path: string, args: EditArgs, mode: EditToolMode): FsEditFileRequest {
  if (mode === 'insert') return buildInsertModeRequest(path, args);
  if (mode === 'delete') return buildDeleteModeRequest(path, args);
  return buildHunkModeRequest(path, args);
}

function buildHunkModeRequest(path: string, args: EditArgs): { path: string; mode: 'hunk'; hunks: FsHunkEditRequest[] } {
  const hunks = normalizeHunks(args.hunks);
  return { path, mode: 'hunk', hunks };
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

function normalizeHunks(value: unknown): FsHunkEditRequest[] {
  if (!Array.isArray(value)) throw new Error('Missing required argument for hunk mode: hunks');
  if (value.length === 0) throw new Error('Missing required argument for hunk mode: hunks must not be empty');
  return value.map((item, index) => {
    const record = asRecord(item);
    if (!record || typeof record.oldContent !== 'string' || typeof record.newContent !== 'string') {
      throw new Error(`Invalid hunk ${index}: each hunk must contain string oldContent and newContent`);
    }
    if (record.oldContent.length === 0) throw new Error(`Invalid hunk ${index}: oldContent must not be empty`);
    return { oldContent: record.oldContent, newContent: record.newContent, replaceAll: record.replaceAll === true };
  });
}

function failedOutput(mode: EditToolMode, path: string, error: string): Record<string, unknown> {
  return {
    kind: 'file_edit.result',
    mode,
    path,
    success: false,
    error,
    summary: `edit(${mode}) failed: ${error}`
  };
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
