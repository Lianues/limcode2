import * as path from 'node:path';
import * as vscode from 'vscode';
import { REGISTERED_STORAGE_ROOT_DIRS } from './constants';
import { comparableFsPath, sameFsPath } from './globalStatus';

export interface StorageRootMigrationResult {
  fromPath: string;
  toPath: string;
  migratedAt: string;
  copiedEntries: string[];
  deletedEntries: string[];
  skipped: boolean;
}

export interface StorageRootCleanupResult {
  deletedEntries: string[];
  failedEntries: Array<{ name: string; error: unknown }>;
}

/**
 * 迁移第一阶段：只复制已注册业务 root，不删除源目录。
 *
 * saveGlobalStatus 成功切换 active root 之前，调用方必须保留旧 root 完整可用，
 * 因此这里即使目标目录已写入部分数据，也绝不清理 sourceRoot。
 */
export async function copyStorageRootForMigration(sourceRoot: vscode.Uri, targetRoot: vscode.Uri): Promise<StorageRootMigrationResult> {
  const migratedAt = new Date().toISOString();
  const fromPath = sourceRoot.fsPath;
  const toPath = targetRoot.fsPath;

  if (sameFsPath(fromPath, toPath)) {
    return { fromPath, toPath, migratedAt, copiedEntries: [], deletedEntries: [], skipped: true };
  }

  assertSafeMigrationRoots(fromPath, toPath);
  await vscode.workspace.fs.createDirectory(targetRoot);

  const copiedEntries: string[] = [];
  for (const name of REGISTERED_STORAGE_ROOT_DIRS) {
    const source = vscode.Uri.joinPath(sourceRoot, name);
    const target = vscode.Uri.joinPath(targetRoot, name);
    if (!await isDirectory(source)) continue;
    await vscode.workspace.fs.copy(source, target, { overwrite: true });
    copiedEntries.push(name);
  }

  return { fromPath, toPath, migratedAt, copiedEntries, deletedEntries: [], skipped: false };
}

/** 迁移第二阶段：active root 已成功切换后，best-effort 清理旧 root。失败只记录，不回滚新 root。 */
export async function cleanupMigratedStorageRoot(sourceRoot: vscode.Uri, copiedEntries: readonly string[]): Promise<StorageRootCleanupResult> {
  const deletedEntries: string[] = [];
  const failedEntries: Array<{ name: string; error: unknown }> = [];
  for (const name of copiedEntries) {
    const source = vscode.Uri.joinPath(sourceRoot, name);
    try {
      if (await deleteDirectoryIfExists(source)) deletedEntries.push(name);
    } catch (error) {
      failedEntries.push({ name, error });
    }
  }
  return { deletedEntries, failedEntries };
}

function assertSafeMigrationRoots(sourcePath: string, targetPath: string): void {
  const source = comparableFsPath(sourcePath);
  const target = comparableFsPath(targetPath);
  if (isNestedPath(source, target) || isNestedPath(target, source)) {
    throw new Error('数据目录迁移不支持源目录与目标目录互为父子目录，请选择一个独立目录。');
  }
}

function isNestedPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

async function deleteDirectoryIfExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

interface FileSystemLikeError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
}

function isFileNotFound(error: unknown): boolean {
  const candidate = error as FileSystemLikeError;
  const text = [
    candidate.name,
    candidate.code,
    candidate.message,
    candidate.stack,
    String(error)
  ].filter((part): part is string => typeof part === 'string').join('\n');

  return /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|not found|no such file|不存在|无法解析不存在的文件/i.test(text);
}
