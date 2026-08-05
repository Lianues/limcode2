import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { writeFileAtomicDurable } from './durableWrite';
import { isNodeFsStorageUri, nodeFsStoragePath } from './localStorageUri';

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
  if (isNodeFsStorageUri(uri)) {
    await fs.mkdir(nodeFsStoragePath(uri), { recursive: true });
    return;
  }
  await vscode.workspace.fs.createDirectory(uri);
}

export async function readStorageDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  if (isNodeFsStorageUri(uri)) {
    const entries = await fs.readdir(nodeFsStoragePath(uri), { withFileTypes: true });
    return entries.map((entry) => [entry.name, storageFileType(entry)]);
  }
  return vscode.workspace.fs.readDirectory(uri);
}

export async function deleteStorageUri(uri: vscode.Uri, options: StorageDeleteOptions = {}): Promise<void> {
  if (isNodeFsStorageUri(uri)) {
    await fs.rm(nodeFsStoragePath(uri), { recursive: options.recursive === true, force: false });
    return;
  }
  await vscode.workspace.fs.delete(uri, {
    recursive: options.recursive === true,
    useTrash: options.useTrash === true
  });
}

export async function readStorageFile(uri: vscode.Uri): Promise<Uint8Array> {
  if (isNodeFsStorageUri(uri)) return fs.readFile(nodeFsStoragePath(uri));
  return vscode.workspace.fs.readFile(uri);
}

/**
 * 原先这里是就地覆盖写：崩溃时目标文件可能被截断或写成半截内容。改为原子 + fsync
 * 发布，保证读到的永远是某一次完整写入的结果。
 */
export async function writeStorageFile(uri: vscode.Uri, data: Uint8Array): Promise<void> {
  if (isNodeFsStorageUri(uri)) {
    await writeFileAtomicDurable(nodeFsStoragePath(uri), data);
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
