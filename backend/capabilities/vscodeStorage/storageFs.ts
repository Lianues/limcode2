import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface StorageDeleteOptions {
  recursive?: boolean;
  useTrash?: boolean;
}

/**
 * Business storage normally resolves to a local file URI. During extension-host
 * shutdown VS Code may cancel workspace.fs requests before deactivate() has
 * finished, while ordinary Node file I/O is still available. Keep local data
 * operations on node:fs and retain workspace.fs only for non-file providers.
 */
export async function ensureStorageDirectory(uri: vscode.Uri): Promise<void> {
  if (uri.scheme === 'file') {
    await fs.mkdir(uri.fsPath, { recursive: true });
    return;
  }
  await vscode.workspace.fs.createDirectory(uri);
}

export async function readStorageDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  if (uri.scheme === 'file') {
    const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, storageFileType(entry)]);
  }
  return vscode.workspace.fs.readDirectory(uri);
}

export async function deleteStorageUri(uri: vscode.Uri, options: StorageDeleteOptions = {}): Promise<void> {
  if (uri.scheme === 'file') {
    await fs.rm(uri.fsPath, { recursive: options.recursive === true, force: false });
    return;
  }
  await vscode.workspace.fs.delete(uri, {
    recursive: options.recursive === true,
    useTrash: options.useTrash === true
  });
}

export async function readStorageFile(uri: vscode.Uri): Promise<Uint8Array> {
  if (uri.scheme === 'file') return fs.readFile(uri.fsPath);
  return vscode.workspace.fs.readFile(uri);
}

export async function writeStorageFile(uri: vscode.Uri, data: Uint8Array): Promise<void> {
  if (uri.scheme === 'file') {
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.writeFile(uri.fsPath, data);
    return;
  }
  await vscode.workspace.fs.writeFile(uri, data);
}

function storageFileType(entry: import('node:fs').Dirent): vscode.FileType {
  if (entry.isFile()) return vscode.FileType.File;
  if (entry.isDirectory()) return vscode.FileType.Directory;
  if (entry.isSymbolicLink()) return vscode.FileType.SymbolicLink;
  return vscode.FileType.Unknown;
}
