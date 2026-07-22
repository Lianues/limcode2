import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withStorageResourceLock } from './storageResourceLock';

export const SHADOW_WORKTREE_LOCKS_DIR = '.locks';
export const SHADOW_WORKTREE_LOCK_STALE_MS = 2 * 60 * 60_000;
export const SHADOW_WORKTREE_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;

export function sanitizeShadowStorageKey(raw: string): string | undefined {
  const key = raw.trim();
  if (!key || key === '.' || key === '..') return undefined;
  if (key.startsWith('.')) return undefined;
  if (!/^[a-zA-Z0-9_.-]+$/.test(key)) return undefined;
  if (key.includes('/') || key.includes('\\') || key.includes('..')) return undefined;
  return key;
}

export function shadowWorktreePath(rootPath: string, storageKey: string): string | undefined {
  const key = sanitizeShadowStorageKey(storageKey);
  if (!key) return undefined;
  const target = path.resolve(rootPath, key);
  return isInsideRoot(rootPath, target) ? target : undefined;
}

export async function withShadowWorktreeLock<T>(rootPath: string, storageKey: string, action: (context: { storageKey: string; worktreePath: string }) => Promise<T>): Promise<T> {
  const key = sanitizeShadowStorageKey(storageKey);
  const worktreePath = key ? shadowWorktreePath(rootPath, key) : undefined;
  if (!key || !worktreePath) throw new Error(`Invalid shadow worktree storageKey: ${storageKey}`);
  const lockPath = path.join(rootPath, SHADOW_WORKTREE_LOCKS_DIR, `${key}.lock`);
  return withStorageResourceLock(vscode.Uri.file(worktreePath), () => action({ storageKey: key, worktreePath }), {
    lockPath,
    staleMs: SHADOW_WORKTREE_LOCK_STALE_MS,
    heartbeatIntervalMs: SHADOW_WORKTREE_LOCK_HEARTBEAT_INTERVAL_MS
  });
}

export async function deleteShadowWorktreeDirectory(rootPath: string, storageKey: string): Promise<{ storageKey: string; worktreePath: string; deleted: boolean }> {
  return withShadowWorktreeLock(rootPath, storageKey, async ({ storageKey: key, worktreePath }) => {
    await fs.rm(worktreePath, { recursive: true, force: true });
    return { storageKey: key, worktreePath, deleted: true };
  });
}

export function isShadowWorktreeDirectoryName(name: string): boolean {
  return sanitizeShadowStorageKey(name) === name;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
