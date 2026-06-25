import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  FsCapability,
  FsDeletePathResult,
  FsEditFileRequest,
  FsEditFileResult,
  FsFileChangeRecord,
  FsDeletePathTargetType,
  FsReadFileResult,
  FsReadLine,
  FsWriteFileResult,
  WorkEnvironmentCapabilityOptions
} from './types';
import {
  WORK_ENVIRONMENT_CAPABILITY,
  workEnvironmentDisplayName,
  workEnvironmentSupportsCapability
} from '../../shared/workEnvironmentCatalog';
import {
  deleteRemoteServerPath,
  isRemoteServerCommandEnvironment,
  readRemoteServerRawTextFile,
  readRemoteServerTextFile,
  RemoteFileNotFoundError,
  writeRemoteServerTextFile
} from './workEnvironmentProvider';
import { buildFileDiffRecord } from './fileDiff';
import { applyHunkEdit, applyPatchEdit } from './editStrategies';

const MAX_BYTES = 256 * 1024;
const MAX_EDIT_READ_BYTES = 2 * 1024 * 1024;

interface RawTextReadResult {
  path: string;
  existed: boolean;
  content: string;
}

/** 函数式 VSCode FS capability 适配器。 */
export function createVsCodeFsCapability(): FsCapability {
  return {
    readFile: (path, startLine, endLine, options) => readWorkspaceTextFile(path, startLine, endLine, options),
    writeFile: (path, content, options) => writeWorkspaceTextFile(path, content, options),
    editFile: (request, options) => editWorkspaceTextFile(request, options),
    deletePath: (path, options) => deleteWorkspacePath(path, options)
  };
}

export async function readWorkspaceTextFile(relPath: string, startLine?: number, endLine?: number, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsReadFileResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    return readRemoteServerTextFile(options.workEnvironment, relPath, startLine, endLine, { allowOutsideProjectPaths: options.allowOutsideProjectPaths });
  }
  const raw = await readWorkspaceRawTextFile(relPath, MAX_BYTES, options);
  if (!raw.existed) throw new Error(`File not found: ${relPath}`);

  const fileLines = raw.content.split(/\r?\n/);
  const from = normalizeStartLine(startLine);
  const to = normalizeEndLine(endLine, fileLines.length);
  const selectedLines: FsReadLine[] = [];

  for (let i = from; i <= to; i += 1) {
    selectedLines.push({ line: i, text: fileLines[i - 1] ?? '' });
  }

  return {
    path: relPath,
    startLine: from,
    endLine: to,
    totalLines: fileLines.length,
    lines: selectedLines,
    content: selectedLines.map((line) => `${line.line} ${line.text}`).join('\n')
  };
}

export async function writeWorkspaceTextFile(relPath: string, content: string, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsWriteFileResult> {
  const path = normalizeDisplayPath(relPath);
  if (!path) throw new Error('Missing required argument: path');
  if (typeof content !== 'string') throw new Error('Missing required argument: content');

  const before = await readWorkspaceRawTextFile(path, MAX_EDIT_READ_BYTES, options);
  const action = before.existed ? (before.content === content ? 'unchanged' : 'modified') : 'created';
  const diff = action === 'unchanged' ? undefined : buildFileDiffRecord(path, before.content, content, before.existed);
  if (action !== 'unchanged') await writeWorkspaceRawTextFile(path, content, options);

  const change: FsFileChangeRecord = {
    path,
    action,
    added: diff?.added ?? 0,
    removed: diff?.removed ?? 0,
    ...(diff ? { diff } : {})
  };
  return {
    kind: 'file_write.result',
    path,
    success: true,
    action,
    summary: writeSummary(path, action),
    changedFiles: action === 'unchanged' ? [] : [path],
    files: [change]
  };
}

export async function editWorkspaceTextFile(
  request: FsEditFileRequest,
  options: WorkEnvironmentCapabilityOptions = {}
): Promise<FsEditFileResult> {
  const path = normalizeDisplayPath(request.path);
  if (!path) throw new Error('Missing required argument: path');

  const before = await readWorkspaceRawTextFile(path, MAX_EDIT_READ_BYTES, options);
  if (!before.existed) throw new Error(`File not found: ${path}`);

  const applied = request.mode === 'patch'
    ? applyPatchEdit(before.content, request.patch ?? '')
    : applyHunkEdit(before.content, request.hunks ?? []);
  if (applied.applied <= 0) {
    const firstError = applied.results.find((item) => !item.success)?.error ?? 'No hunks were applied.';
    throw new Error(`edit(${request.mode}) failed: ${firstError}`);
  }

  const action = applied.newContent === before.content ? 'unchanged' : 'modified';
  const diff = action === 'unchanged' ? undefined : buildFileDiffRecord(path, before.content, applied.newContent, true);
  if (action !== 'unchanged') await writeWorkspaceRawTextFile(path, applied.newContent, options);

  const change: FsFileChangeRecord = {
    path,
    action,
    added: diff?.added ?? 0,
    removed: diff?.removed ?? 0,
    ...(diff ? { diff } : {})
  };
  return {
    kind: 'file_edit.result',
    mode: request.mode,
    path,
    success: true,
    action,
    totalHunks: applied.totalHunks,
    applied: applied.applied,
    failed: applied.failed,
    ...(applied.fallbackMode ? { fallbackMode: applied.fallbackMode } : {}),
    results: applied.results,
    summary: editSummary(path, request.mode, action, applied.applied, applied.failed, applied.fallbackMode),
    changedFiles: action === 'unchanged' ? [] : [path],
    files: [change]
  };
}

export async function deleteWorkspacePath(relPath: string, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsDeletePathResult> {
  const targetPath = normalizePathArg(relPath);
  if (!targetPath) throw new Error('Missing required argument: path');

  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    const deleted = await deleteRemoteServerPath(options.workEnvironment, targetPath, { allowOutsideProjectPaths: options.allowOutsideProjectPaths });
    return deleteResult(targetPath, deleted.path, deleted.targetType);
  }

  const uri = resolveWorkspacePath(targetPath, options, 'write', { rejectProjectRoot: true });
  const stat = await workspaceFileStat(uri);
  if (!stat) throw new Error(`Path not found: ${targetPath}`);
  const targetType = fileTypeFromStat(stat, targetPath);
  assertSafeLocalDeleteTarget(uri, projectRootUri(options));
  await vscode.workspace.fs.delete(uri, { recursive: true });
  return deleteResult(targetPath, uri.fsPath || targetPath, targetType);
}

function deleteResult(inputPath: string, resolvedPath: string, targetType: FsDeletePathTargetType): FsDeletePathResult {
  return {
    inputPath,
    path: resolvedPath,
    targetType
  };
}


async function readWorkspaceRawTextFile(relPath: string, maxBytes: number, options: WorkEnvironmentCapabilityOptions): Promise<RawTextReadResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    try {
      const content = await readRemoteServerRawTextFile(options.workEnvironment, relPath, maxBytes, { allowOutsideProjectPaths: options.allowOutsideProjectPaths });
      return { path: relPath, existed: true, content };
    } catch (error) {
      if (error instanceof RemoteFileNotFoundError) return { path: relPath, existed: false, content: '' };
      throw error;
    }
  }

  const uri = resolveWorkspacePath(relPath, options, 'read');
  const stat = await workspaceFileStat(uri);
  if (!stat) return { path: relPath, existed: false, content: '' };
  if (stat.type !== vscode.FileType.File) throw new Error(`Not a file: ${relPath}`);
  if (stat.size > maxBytes) throw new Error(`File too large: ${stat.size} bytes (limit ${maxBytes}).`);
  const data = await vscode.workspace.fs.readFile(uri);
  return { path: relPath, existed: true, content: Buffer.from(data).toString('utf8') };
}

async function workspaceFileStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

async function writeWorkspaceRawTextFile(relPath: string, content: string, options: WorkEnvironmentCapabilityOptions): Promise<void> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    await writeRemoteServerTextFile(options.workEnvironment, relPath, content, { allowOutsideProjectPaths: options.allowOutsideProjectPaths });
    return;
  }

  const uri = resolveWorkspacePath(relPath, options, 'write');
  await vscode.workspace.fs.createDirectory(dirnameUri(uri));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

function normalizeStartLine(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeEndLine(value: number | undefined, totalLines: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return totalLines;
  return Math.min(totalLines, Math.max(1, Math.floor(value)));
}

interface WorkspacePathResolveOptions {
  rejectProjectRoot?: boolean;
}

function resolveWorkspacePath(
  relPath: string,
  options: WorkEnvironmentCapabilityOptions,
  mode: 'read' | 'write',
  resolveOptions: WorkspacePathResolveOptions = {}
): vscode.Uri {
  const workEnvironment = options.workEnvironment;
  if (workEnvironment?.available === false) {
    throw new Error(`当前工作环境不可用：${workEnvironmentDisplayName(workEnvironment)}`);
  }
  if (workEnvironment && mode === 'read' && !workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalFileRead)) {
    throw new Error(`当前工作环境暂不支持本地文件读取：${workEnvironmentDisplayName(workEnvironment)} (${workEnvironment.kind})`);
  }
  if (workEnvironment && mode === 'write' && !workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.FileTransferWrite)) {
    throw new Error(`当前工作环境暂不支持本地文件写入：${workEnvironmentDisplayName(workEnvironment)} (${workEnvironment.kind})`);
  }

  const targetPath = normalizePathArg(relPath);
  if (!targetPath) throw new Error('Missing required argument: path');
  const root = projectRootUri(options);
  const isAbsolute = isAbsoluteLocalPath(targetPath);
  if (!isAbsolute && !root && resolveOptions.rejectProjectRoot === true) {
    throw new Error(`当前工作区缺少项目根目录，无法解析相对删除路径：${targetPath}`);
  }
  const uri = isAbsolute
    ? vscode.Uri.file(targetPath)
    : root
      ? vscode.Uri.file(path.resolve(root.fsPath, relativeLocalPath(targetPath)))
      : vscode.Uri.file(targetPath);

  if (options.allowOutsideProjectPaths === false) {
    if (!root) throw new Error('当前工作区缺少项目根目录，无法限制项目外路径。');
    assertLocalPathInsideRoot(uri, root);
  }
  if (resolveOptions.rejectProjectRoot === true) assertSafeLocalDeleteTarget(uri, root);
  return uri;
}

function projectRootUri(options: WorkEnvironmentCapabilityOptions): vscode.Uri | undefined {
  const workEnvironment = options.workEnvironment;
  if (workEnvironment && workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalFileRead)) {
    const rootPath = normalizePathArg(workEnvironment.rootPath);
    if (rootPath) return vscode.Uri.file(rootPath);
    const uri = normalizePathArg(workEnvironment.uri);
    if (uri) return vscode.Uri.parse(uri);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function isAbsoluteLocalPath(input: string): boolean {
  return path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input);
}

function relativeLocalPath(input: string): string {
  return input.replace(/[\\/]+/g, path.sep);
}

function assertLocalPathInsideRoot(uri: vscode.Uri, root: vscode.Uri): void {
  const candidate = canonicalLocalPath(uri.fsPath);
  const rootPath = canonicalLocalPath(root.fsPath);
  const relative = path.relative(rootPath, candidate);
  if (relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`路径超出当前项目/工作环境根目录：${uri.fsPath}（root=${root.fsPath}）`);
}

function canonicalLocalPath(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameLocalPath(left: string, right: string): boolean {
  return canonicalLocalPath(left) === canonicalLocalPath(right);
}

function assertSafeLocalDeleteTarget(uri: vscode.Uri, root: vscode.Uri | undefined): void {
  const target = path.resolve(uri.fsPath);
  const filesystemRoot = path.parse(target).root;
  if (!target || sameLocalPath(target, filesystemRoot)) throw new Error('拒绝删除本地文件系统根目录。');
  if (root && sameLocalPath(target, root.fsPath)) throw new Error(`拒绝删除当前项目/工作环境根目录：${target}`);
}

function fileTypeFromStat(stat: vscode.FileStat, targetPath: string): FsDeletePathTargetType {
  if ((stat.type & vscode.FileType.Directory) !== 0) return 'directory';
  if ((stat.type & vscode.FileType.File) !== 0 || (stat.type & vscode.FileType.SymbolicLink) !== 0) return 'file';
  throw new Error(`Unsupported path type: ${targetPath}`);
}

function dirnameUri(uri: vscode.Uri): vscode.Uri {
  const parts = uri.path.split('/');
  parts.pop();
  const dirPath = parts.join('/') || '/';
  return uri.with({ path: dirPath });
}

function normalizePathArg(path: string | undefined): string {
  return typeof path === 'string' ? path.trim() : '';
}

function normalizeDisplayPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}

function writeSummary(path: string, action: FsWriteFileResult['action']): string {
  if (action === 'created') return `已创建 ${path}`;
  if (action === 'modified') return `已写入 ${path}`;
  if (action === 'deleted') return `已删除 ${path}`;
  return `${path} 内容未变化`;
}

function editSummary(path: string, mode: FsEditFileRequest['mode'], action: FsEditFileResult['action'], applied: number, failed: number, fallbackMode: string | undefined): string {
  if (action === 'unchanged') return `${path} 内容未变化`;
  const fallback = fallbackMode ? `，fallback=${fallbackMode}` : '';
  return `已用 ${mode} 模式修改 ${path}（成功 ${applied} 个 hunk，失败 ${failed} 个${fallback}）`;
}
