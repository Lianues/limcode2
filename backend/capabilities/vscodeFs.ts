import * as vscode from 'vscode';
import type {
  FsCapability,
  FsEditFileRequest,
  FsEditFileResult,
  FsFileChangeRecord,
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
    editFile: (request, options) => editWorkspaceTextFile(request, options)
  };
}

export async function readWorkspaceTextFile(relPath: string, startLine?: number, endLine?: number, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsReadFileResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    return readRemoteServerTextFile(options.workEnvironment, relPath, startLine, endLine);
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

async function readWorkspaceRawTextFile(relPath: string, maxBytes: number, options: WorkEnvironmentCapabilityOptions): Promise<RawTextReadResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    try {
      const content = await readRemoteServerRawTextFile(options.workEnvironment, relPath, maxBytes);
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
    await writeRemoteServerTextFile(options.workEnvironment, relPath, content);
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

function resolveWorkspacePath(relPath: string, options: WorkEnvironmentCapabilityOptions, mode: 'read' | 'write'): vscode.Uri {
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

  const folders = vscode.workspace.workspaceFolders;
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(relPath);
  const environmentRoot = workEnvironment && workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalFileRead) && workEnvironment.uri
    ? vscode.Uri.parse(workEnvironment.uri)
    : undefined;
  if (environmentRoot && !isAbsolute) {
    return joinPath(environmentRoot, relPath);
  }
  if (folders && folders.length > 0 && !isAbsolute) {
    return joinPath(folders[0].uri, relPath);
  }
  return vscode.Uri.file(relPath);
}

function dirnameUri(uri: vscode.Uri): vscode.Uri {
  const parts = uri.path.split('/');
  parts.pop();
  const dirPath = parts.join('/') || '/';
  return uri.with({ path: dirPath });
}

function joinPath(root: vscode.Uri, relPath: string): vscode.Uri {
  const parts = relPath.replace(/\\+/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? vscode.Uri.joinPath(root, ...parts) : root;
}

function normalizeDisplayPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}

function writeSummary(path: string, action: FsWriteFileResult['action']): string {
  if (action === 'created') return `已创建 ${path}`;
  if (action === 'modified') return `已写入 ${path}`;
  return `${path} 内容未变化`;
}

function editSummary(path: string, mode: FsEditFileRequest['mode'], action: FsEditFileResult['action'], applied: number, failed: number, fallbackMode: string | undefined): string {
  if (action === 'unchanged') return `${path} 内容未变化`;
  const fallback = fallbackMode ? `，fallback=${fallbackMode}` : '';
  return `已用 ${mode} 模式修改 ${path}（成功 ${applied} 个 hunk，失败 ${failed} 个${fallback}）`;
}
