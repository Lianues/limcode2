import { IconFileDiff, IconPencil, IconTrash, IconWriting } from '@tabler/icons-vue';
import { DELETE_TOOL_NAME, EDIT_TOOL_NAME, WRITE_TOOL_NAME } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';
import type { CheckpointRecord, CheckpointTimelineAnchorRecord } from '@shared/protocol';
import type { ToolDisplayContext, ToolDisplayDiff, ToolDisplayResolver, ToolDisplaySection, ToolHeaderAction, ToolHeaderPreview } from './types';

interface WriteArgs {
  path?: string;
  content?: string;
}

interface EditArgs {
  path?: string;
  hunks?: unknown;
  insert?: { line?: number; content?: string };
  delete?: { startLine?: number; endLine?: number };
}

interface DeleteArgs {
  paths: string[];
}

interface FileChangeOutput {
  kind?: string;
  path?: string;
  action?: string;
  error?: string;
  summary?: string;
  mode?: string;
  totalHunks?: number;
  applied?: number;
  failed?: number | unknown[];
  fallbackMode?: string;
  changedFiles?: unknown;
  paths?: unknown;
  requestedPaths?: unknown;
  deleted?: unknown;
  files?: unknown;
  results?: unknown;
  totalCount?: number;
  successCount?: number;
  failCount?: number;
}

interface FileChangeItem {
  path: string;
  action?: string;
  added?: number;
  removed?: number;
  diffText?: string;
  truncated?: boolean;
}

export const writeToolDisplay: ToolDisplayResolver = (context) => {
  const args = writeArgs(context.args);
  const inputSections = writeInputSections(args, context);
  const output = fileChangeOutput(context.result) ?? fileChangeOutput(context.progress);
  const outputSections = fileChangeOutputSections('写入结果', output, context);
  const diff = diffFromOutput(output);
  const headerPreview = fileHeaderPreview(args.path, output);

  return {
    headerIcon: IconWriting,
    inputSections,
    ...(outputSections ? { outputSections } : {}),
    headerActions: diff ? diffHeaderActions(context, diff) : [],
    ...(headerPreview ? { headerPreview } : {})
  };
};

export const editToolDisplay: ToolDisplayResolver = (context) => {
  const args = editArgs(context.args);
  const inputSections = editInputSections(args, context);
  const output = fileChangeOutput(context.result) ?? fileChangeOutput(context.progress);
  const outputSections = fileChangeOutputSections('修改结果', output, context);
  const diff = diffFromOutput(output);
  const headerPreview = fileHeaderPreview(args.path, output);

  return {
    headerIcon: IconPencil,
    inputSections,
    ...(outputSections ? { outputSections } : {}),
    headerActions: diff ? diffHeaderActions(context, diff) : [],
    ...(headerPreview ? { headerPreview } : {})
  };
};

export const deleteToolDisplay: ToolDisplayResolver = (context) => {
  const args = deleteArgs(context.args);
  const inputSections = deleteInputSections(args, context);
  const output = fileChangeOutput(context.result) ?? fileChangeOutput(context.progress);
  const outputSections = deleteOutputSections(output, context);
  const headerPreview = deleteHeaderPreview(args.paths, output);

  return {
    headerIcon: IconTrash,
    inputSections,
    ...(outputSections ? { outputSections } : {}),
    headerActions: [],
    ...(headerPreview ? { headerPreview } : {})
  };
};


function writeInputSections(args: WriteArgs, context: ToolDisplayContext): ToolDisplaySection[] {
  const path = normalizePath(args.path);
  if (!path) return [{ kind: 'input', title: '输入', text: context.stringifyValue(context.args) }];
  return [{
    kind: 'input',
    title: '写入参数',
    rows: parameterRows([
      { label: 'path', value: path },
      { label: 'content', value: typeof args.content === 'string' ? `${args.content.length} 字符` : undefined }
    ]),
    rowStyle: 'keyValue'
  }];
}

function editInputSections(args: EditArgs, context: ToolDisplayContext): ToolDisplaySection[] {
  const path = normalizePath(args.path);
  if (!path) return [{ kind: 'input', title: '输入', text: context.stringifyValue(context.args) }];
  return [{
    kind: 'input',
    title: '修改参数',
    rows: parameterRows([
      { label: 'path', value: path },
      { label: 'hunks', value: Array.isArray(args.hunks) ? `${args.hunks.length} 个` : undefined },
      { label: 'insert', value: args.insert ? `第 ${args.insert.line} 行，${args.insert.content?.length ?? 0} 字符` : undefined },
      { label: 'delete', value: args.delete ? `第 ${args.delete.startLine}-${args.delete.endLine} 行` : undefined }
    ]),
    rowStyle: 'keyValue'
  }];
}

function deleteInputSections(args: DeleteArgs, context: ToolDisplayContext): ToolDisplaySection[] {
  if (args.paths.length === 0) return [{ kind: 'input', title: '输入', text: context.stringifyValue(context.args) }];
  return [{
    kind: 'input',
    title: '请求删除路径',
    rows: args.paths.map((path, index) => ({ label: String(index + 1), value: normalizePath(path) })),
    rowStyle: 'lineNumber'
  }];
}

function deleteOutputSections(output: FileChangeOutput | string | undefined, context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  if (output === undefined) return undefined;
  if (typeof output === 'string') return output ? [{ kind: 'output', title: '删除结果', text: output }] : undefined;

  const rows = parameterRows([
    { label: 'summary', value: stringValue(output.summary) },
    { label: 'error', value: stringValue(output.error) },
    { label: 'total', value: numberValue(output.totalCount)?.toString() },
    { label: 'success', value: numberValue(output.successCount)?.toString() },
    { label: 'failed', value: numberValue(output.failCount)?.toString() }
  ]);
  const sections: ToolDisplaySection[] = rows.length > 0
    ? [{ kind: 'output', title: '删除结果', rows, rowStyle: 'keyValue' }]
    : [];

  const pathRows = deletePathRows(output);
  if (pathRows.length > 0) {
    sections.push({
      kind: 'output',
      title: '删除路径',
      rows: pathRows,
      rowStyle: 'lineNumber'
    });
  }

  if (sections.length === 0) sections.push({ kind: 'output', title: '删除结果', text: context.stringifyValue(output) });
  return sections;
}

function fileChangeOutputSections(title: string, output: FileChangeOutput | string | undefined, context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  if (output === undefined) return undefined;
  if (typeof output === 'string') return output ? [{ kind: 'output', title, text: output }] : undefined;

  const rows = parameterRows([
    { label: 'summary', value: stringValue(output.summary) },
    { label: 'error', value: stringValue(output.error) },
    { label: 'path', value: normalizePath(output.path) || undefined },
    { label: 'mode', value: stringValue(output.mode) },
    { label: 'action', value: actionLabel(stringValue(output.action)) },
    { label: 'edits', value: editCountText(output) },
    { label: 'fallback', value: stringValue(output.fallbackMode) },
    { label: 'changedFiles', value: changedFilesText(output.changedFiles) }
  ]);
  const sections: ToolDisplaySection[] = rows.length > 0
    ? [{ kind: 'output', title, rows, rowStyle: 'keyValue' }]
    : [{ kind: 'output', title, text: context.stringifyValue(output) }];

  const diff = diffFromOutput(output);
  if (diff) sections.push({ kind: 'output', title: 'Diff 预览', diff });
  return sections;
}

function diffFromOutput(output: FileChangeOutput | string | undefined): ToolDisplayDiff | undefined {
  if (!output || typeof output === 'string') return undefined;
  const files = fileChangeItems(output.files)
    .filter((file) => file.diffText && file.diffText.trim())
    .map((file) => ({
      path: file.path,
      action: actionLabel(file.action),
      added: file.added,
      removed: file.removed,
      truncated: file.truncated,
      text: file.diffText ?? ''
    }));
  if (files.length === 0) return undefined;
  return { files, summary: output.summary };
}

function fileHeaderPreview(inputPath: string | undefined, output: FileChangeOutput | string | undefined): ToolHeaderPreview | undefined {
  const path = normalizePath(inputPath);
  if (!path) return undefined;
  const fileName = extractFileName(path);
  if (!fileName) return undefined;

  const items = fileChangeItems(typeof output === 'object' ? output?.files : undefined);
  if (items.length > 0) {
    const matched = items.find((item) => normalizePath(item.path) === path) ?? items[0];
    return {
      fileName,
      filePath: path,
      added: matched.added,
      removed: matched.removed
    };
  }
  return { fileName, filePath: path };
}

function deleteHeaderPreview(paths: string[], output: FileChangeOutput | string | undefined): ToolHeaderPreview | undefined {
  const firstPath = paths.length > 0 ? normalizePath(paths[0]) : undefined;
  const path = firstPath ?? normalizePath(typeof output === 'object' ? output?.path : undefined);
  if (!path) return undefined;
  const fileName = extractFileName(path);
  if (!fileName) return undefined;

  const items = fileChangeItems(typeof output === 'object' ? output?.files : undefined);
  if (items.length > 0) {
    const matched = items.find((item) => normalizePath(item.path) === path) ?? items[0];
    return {
      fileName,
      filePath: path,
      added: matched.added,
      removed: matched.removed
    };
  }
  return { fileName, filePath: path };
}

function extractFileName(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const name = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return name.trim() || undefined;
}

function diffHeaderActions(context: ToolDisplayContext, diff: ToolDisplayDiff): ToolHeaderAction[] {
  const filePath = diff.files[0]?.path;
  const toolCallId = context.toolCall?.id;
  const conversationId = context.currentConversationId;
  if (!filePath || !toolCallId || !conversationId) return [];

  const availability = checkpointDiffAvailability(context, toolCallId);
  return [{
    id: `open-shadow-diff-${toolCallId}`,
    label: '查看差异',
    title: availability.title,
    icon: IconFileDiff,
    disabled: !availability.checkpoint,
    invoke: () => {
      if (!availability.checkpoint) return;
      bridge.request(BridgeMessageType.CheckpointDiffOpen, {
        conversationId,
        checkpointId: availability.checkpoint.id,
        filePath
      });
    }
  }];
}

function checkpointDiffAvailability(
  context: ToolDisplayContext,
  toolCallId: string
): { checkpoint?: CheckpointRecord; title: string } {
  const checkpointStore = useCheckpointPolicyStore();
  checkpointStore.ensureShadowStats();
  const anchor = latestAfterCheckpointAnchor(context.checkpointTimelineAnchors ?? [], toolCallId);
  if (!anchor) return { title: '等待 shadow 存档点创建后可查看 VS Code 差异' };
  const checkpoint = context.checkpoints?.find((item) => item.id === anchor.checkpointId);
  if (!checkpoint) return { title: '等待存档点同步到前端后可查看差异' };
  if (checkpoint.status === 'pending') return { title: '存档点正在创建，稍后可查看差异' };
  if (checkpoint.status !== 'created' || !checkpoint.commitSha) return { title: checkpoint.message ?? '存档点创建失败，无法查看差异' };
  const shadowRepository = context.shadowRepositories?.find((item) => item.id === checkpoint.shadowRepositoryId);
  if (!shadowRepository) return { title: '未找到此存档点关联的 shadow 仓库，无法查看差异' };
  const shadowStat = checkpointStore.shadowStats.find((item) => item.storageKey === shadowRepository.storageKey);
  if (shadowStat && !shadowStat.exists) return { title: 'shadow 仓库已删除，无法查看差异' };
  if (!shadowStat && checkpointStore.shadowStatsLoaded) return { title: 'shadow 仓库不存在，无法查看差异' };
  if (!shadowStat && checkpointStore.shadowStatsLoading) return { title: '正在确认 shadow 仓库状态，请稍候' };
  return { checkpoint, title: '在 VS Code Diff 编辑器中查看 shadow 存档差异' };
}

function latestAfterCheckpointAnchor(anchors: readonly CheckpointTimelineAnchorRecord[], toolCallId: string): CheckpointTimelineAnchorRecord | undefined {
  return anchors
    .filter((anchor) => anchor.sourceToolCallId === toolCallId && anchor.position === 'after')
    .sort((left, right) => right.createdAt - left.createdAt || right.order - left.order || right.id.localeCompare(left.id))[0];
}

function fileChangeOutput(value: unknown): FileChangeOutput | string | undefined {
  const unwrapped = toolOutput(value);
  if (typeof unwrapped === 'string') return unwrapped;
  const record = asRecord(unwrapped);
  if (!record) return undefined;
  return record as FileChangeOutput;
}

function toolOutput(result: unknown): unknown {
  const record = asRecord(result);
  return record && 'output' in record ? record.output : result;
}

function fileChangeItems(value: unknown): FileChangeItem[] {
  if (!Array.isArray(value)) return [];
  const result: FileChangeItem[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const path = normalizePath(record.path);
    if (!path) continue;
    const diff = asRecord(record.diff);
    result.push({
      path,
      action: stringValue(record.action),
      added: numberValue(record.added) ?? numberValue(diff?.added),
      removed: numberValue(record.removed) ?? numberValue(diff?.removed),
      diffText: stringValue(diff?.text),
      truncated: booleanValue(diff?.truncated)
    });
  }
  return result;
}

function writeArgs(value: unknown): WriteArgs {
  const record = asRecord(value);
  if (!record) return {};
  return { path: stringValue(record.path), content: stringValue(record.content) };
}

function editArgs(value: unknown): EditArgs {
  const record = asRecord(value);
  if (!record) return {};
  return {
    path: stringValue(record.path),
    hunks: record.hunks,
    insert: asRecord(record.insert) ? { line: numberValue(asRecord(record.insert)?.line), content: stringValue(asRecord(record.insert)?.content) } : undefined,
    delete: asRecord(record.delete) ? { startLine: numberValue(asRecord(record.delete)?.startLine), endLine: numberValue(asRecord(record.delete)?.endLine) } : undefined
  };
}

function deleteArgs(value: unknown): DeleteArgs {
  const record = asRecord(value);
  return { paths: stringArray(record?.paths) };
}

function editCountText(output: FileChangeOutput): string | undefined {
  if (output.totalHunks === undefined && output.applied === undefined && output.failed === undefined) return undefined;
  return `${numberValue(output.applied) ?? 0}/${numberValue(output.totalHunks) ?? 0} 成功，${numberValue(output.failed) ?? 0} 失败`;
}

function parameterRows(items: Array<{ label: string; value: string | undefined }>): Array<{ label: string; value: string }> {
  return items.filter((item): item is { label: string; value: string } => Boolean(item.value));
}

function changedFilesText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (files.length === 0) return '无';
  return files.join(', ');
}

function actionLabel(action: string | undefined): string | undefined {
  if (action === 'created') return '创建';
  if (action === 'modified') return '修改';
  if (action === 'deleted') return '删除';
  if (action === 'unchanged') return '未变化';
  return action;
}

function deletePathRows(output: FileChangeOutput): Array<{ label: string; value: string }> {
  const compact = compactDeletePathRows(output.paths);
  if (compact.length > 0) return compact;

  const legacyDeleted = legacyDeleteRows(output.deleted, true);
  const legacyFailed = legacyDeleteRows(output.failed, false);
  if (legacyDeleted.length > 0 || legacyFailed.length > 0) return [...legacyDeleted, ...legacyFailed];

  const explicitPaths = stringArray(output.paths);
  if (explicitPaths.length > 0) return explicitPaths.map((path, index) => ({ label: String(index + 1), value: `${normalizePath(path)} · 成功` }));

  const resultPaths = deleteResultPaths(output.results);
  if (resultPaths.length > 0) return resultPaths.map((path, index) => ({ label: String(index + 1), value: `${normalizePath(path)} · 成功` }));

  const changedFiles = stringArray(output.changedFiles);
  if (changedFiles.length > 0) return changedFiles.map((path, index) => ({ label: String(index + 1), value: `${normalizePath(path)} · 成功` }));

  return fileChangeItems(output.files).map((item, index) => ({ label: String(index + 1), value: `${normalizePath(item.path)} · 成功` }));
}

function compactDeletePathRows(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ label: string; value: string }> = [];
  for (const item of value) {
    const record = asRecord(item);
    const path = stringValue(record?.path);
    const success = booleanValue(record?.success);
    if (!path || success === undefined) continue;
    rows.push({ label: String(rows.length + 1), value: `${normalizePath(path)} · ${success ? '成功' : '失败'}` });
  }
  return rows;
}

function legacyDeleteRows(value: unknown, success: boolean): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ label: string; value: string }> = [];
  for (const item of value) {
    const record = asRecord(item);
    const path = stringValue(record?.path) ?? stringValue(record?.inputPath);
    if (!path) continue;
    rows.push({ label: String(rows.length + 1), value: `${normalizePath(path)} · ${success ? '成功' : '失败'}` });
  }
  return rows;
}

function deleteResultPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(asRecord(item)?.path))
    .filter((path): path is string => !!path?.trim());
}

function normalizePath(path: unknown): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export const FILE_CHANGE_TOOL_NAMES = [EDIT_TOOL_NAME, WRITE_TOOL_NAME, DELETE_TOOL_NAME] as const;
