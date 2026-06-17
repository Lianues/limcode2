import * as vscode from 'vscode';
import type { FsCapability, FsReadFileResult, FsReadLine, WorkEnvironmentCapabilityOptions } from './types';
import {
  WORK_ENVIRONMENT_CAPABILITY,
  workEnvironmentDisplayName,
  workEnvironmentSupportsCapability
} from '../../shared/workEnvironmentCatalog';
import { isRemoteServerCommandEnvironment, readRemoteServerTextFile } from './workEnvironmentProvider';

const MAX_BYTES = 256 * 1024;

/** 函数式 VSCode FS capability 适配器。 */
export function createVsCodeFsCapability(): FsCapability {
  return {
    readFile: (path, startLine, endLine, options) => readWorkspaceTextFile(path, startLine, endLine, options)
  };
}

export async function readWorkspaceTextFile(relPath: string, startLine?: number, endLine?: number, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsReadFileResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    return readRemoteServerTextFile(options.workEnvironment, relPath, startLine, endLine);
  }
  const uri = resolveWorkspacePath(relPath, options);
  const data = await vscode.workspace.fs.readFile(uri);
  if (data.byteLength > MAX_BYTES) {
    throw new Error(`File too large: ${data.byteLength} bytes (limit ${MAX_BYTES}).`);
  }

  const text = Buffer.from(data).toString('utf8');
  const fileLines = text.split(/\r?\n/);
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

function normalizeStartLine(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeEndLine(value: number | undefined, totalLines: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return totalLines;
  return Math.min(totalLines, Math.max(1, Math.floor(value)));
}

function resolveWorkspacePath(relPath: string, options: WorkEnvironmentCapabilityOptions): vscode.Uri {
  const workEnvironment = options.workEnvironment;
  if (workEnvironment && !workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalFileRead)) {
    throw new Error(`当前工作环境暂不支持本地文件读取：${workEnvironmentDisplayName(workEnvironment)} (${workEnvironment.kind})`);
  }
  if (workEnvironment?.available === false) {
    throw new Error(`当前工作环境不可用：${workEnvironmentDisplayName(workEnvironment)}`);
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

function joinPath(root: vscode.Uri, relPath: string): vscode.Uri {
  const parts = relPath.replace(/\\+/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? vscode.Uri.joinPath(root, ...parts) : root;
}
