import * as path from 'node:path';
import * as vscode from 'vscode';

const NODE_FS_STORAGE_SCHEMES = new Set(['file', 'vscode-userdata']);

/**
 * VS Code exposes the default extension globalStorageUri as `vscode-userdata:` in
 * some desktop builds even though it resolves to the local user-data directory.
 * Business storage under that URI must still use real local filesystem locks;
 * otherwise two Extension Host processes will only be serialized in-memory.
 */
export function isNodeFsStorageUri(uri: vscode.Uri): boolean {
  return NODE_FS_STORAGE_SCHEMES.has(uri.scheme) && hasUsableFsPath(uri);
}

export function nodeFsStoragePath(uri: vscode.Uri): string {
  if (!isNodeFsStorageUri(uri)) throw new Error(`Storage URI is not backed by local node fs: ${uri.toString()}`);
  return normalizeFsPath(uri.fsPath);
}

function hasUsableFsPath(uri: vscode.Uri): boolean {
  const fsPath = normalizeFsPath(uri.fsPath);
  return !!fsPath && path.isAbsolute(fsPath);
}

function normalizeFsPath(fsPath: string): string {
  if (!fsPath) return '';
  const candidate = process.platform === 'win32' && /^[\\/][a-zA-Z]:[\\/]/.test(fsPath)
    ? fsPath.slice(1)
    : fsPath;
  return path.resolve(candidate);
}
