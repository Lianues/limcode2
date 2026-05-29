import * as vscode from 'vscode';
import type { FsCapability } from './types';

const MAX_BYTES = 256 * 1024;

/** 函数式 VSCode FS capability 适配器。 */
export function createVsCodeFsCapability(): FsCapability {
  return {
    readFile: (path, startLine, endLine) => readWorkspaceTextFile(path, startLine, endLine)
  };
}

export async function readWorkspaceTextFile(relPath: string, startLine?: number, endLine?: number): Promise<string> {
  const uri = resolveWorkspacePath(relPath);
  const data = await vscode.workspace.fs.readFile(uri);
  if (data.byteLength > MAX_BYTES) {
    throw new Error(`File too large: ${data.byteLength} bytes (limit ${MAX_BYTES}).`);
  }

  const text = Buffer.from(data).toString('utf8');
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? lines.length);
  const width = String(to).length;

  const out: string[] = [];
  for (let i = from; i <= to; i += 1) {
    out.push(`${String(i).padStart(width, ' ')} | ${lines[i - 1]}`);
  }
  return out.join('\n');
}

function resolveWorkspacePath(relPath: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(relPath);
  if (folders && folders.length > 0 && !isAbsolute) {
    return vscode.Uri.joinPath(folders[0].uri, relPath);
  }
  return vscode.Uri.file(relPath);
}
