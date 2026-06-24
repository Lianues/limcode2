import { EDIT_TOOL_NAME, type EditToolMode } from '../../../../../../shared/protocol';
import type { FsStructuredEditHunk } from '../../../../../capabilities/types';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolDefinition, ToolDeps } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

interface EditArgs {
  path?: string;
  patch?: string;
  hunks?: unknown;
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
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: true,
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
        }
      ]
    },
    defaultConfig: { mode: EDIT_TOOL_MODE_DEFAULT }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'filesystem_edit_side_effect'),
  summary: summarizeEditToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as EditArgs;
    const mode = editModeFromConfig(ctx?.config);
    const path = normalizeDisplayPath(args.path);
    if (!path) return { ok: false, output: await failedOutput(deps, mode, path, 'Missing required argument: path') };

    try {
      const request = mode === 'patch'
        ? buildPatchModeRequest(path, args)
        : buildHunkModeRequest(path, args);
      const result = await deps.fs.editFile(request, { workEnvironment: ctx?.workEnvironment });
      await recordStatistics(deps, mode, result.success);
      return { ok: result.success, output: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: await failedOutput(deps, mode, path, message) };
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
    'Use multiple hunks in one call for multiple independent edits in the same file. For new files or full rewrites, use write.'
  ].join('\n');
}

export function hunkModeParameters(): unknown {
  return {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root.' },
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
    'Do not include multi-file patches or /dev/null create/delete patches. Use write for new files.'
  ].join('\n');
}

export function patchModeParameters(): unknown {
  return {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root.' },
      patch: {
        type: 'string',
        description: 'Unified diff patch for this single file. Hunk lines use prefix space=context, -=delete, +=add. Bare @@ hunks are allowed as a loose fallback when enough context is present.'
      }
    },
    required: ['path', 'patch']
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
