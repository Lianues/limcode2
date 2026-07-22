import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ShadowCheckpointDiffOpenRequest, ShadowCheckpointDiffOpenResult } from '../types';
import type { StoragePaths } from './clientStateStore';
import { withShadowWorktreeLock } from './shadowWorktreeLock';

const SHADOW_DIFF_SCHEME = 'limcode-shadow';
const EMPTY_DOCUMENT_COMMIT = '__limcode_empty__';
const GIT_COMMAND_TIMEOUT_MS = 30_000;

interface GitRunResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

let shadowDiffProviderDisposable: vscode.Disposable | undefined;

export function registerShadowDiffProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(ensureShadowDiffProviderRegistered());
}

export async function openShadowCheckpointDiff(
  paths: StoragePaths,
  request: ShadowCheckpointDiffOpenRequest
): Promise<ShadowCheckpointDiffOpenResult> {
  const filePath = normalizeGitRelativePath(request.filePath);
  if (!filePath) return { status: 'failed', message: '文件路径为空，无法打开差异。' };
  if (!request.commitSha) return { status: 'failed', message: '该存档点没有可用于比较的 commit。' };

  try {
    return await withShadowWorktreeLock(paths.checkpointShadowWorktreesRootPath, request.shadowRepositoryStorageKey, async ({ worktreePath }) => {
      if (!(await exists(path.join(worktreePath, '.git')))) {
        return { status: 'failed', message: 'shadow 仓库不存在或已被删除，无法打开差异。' };
      }

      const commitCheck = await runGit(worktreePath, ['cat-file', '-e', `${request.commitSha}^{commit}`], { allowExitCodes: [0, 128] });
      if (commitCheck.exitCode !== 0) return { status: 'failed', message: '存档点对应的 commit 已不存在，无法打开差异。' };

      const parentSha = await resolveParentCommit(worktreePath, request.commitSha);
      const changed = await fileChangedInCommit(worktreePath, request.commitSha, parentSha, filePath);
      if (!changed) return { status: 'failed', message: '该存档点没有记录此文件的变化。' };

      ensureShadowDiffProviderRegistered();
      const leftCommit = parentSha ?? EMPTY_DOCUMENT_COMMIT;
      const leftUri = shadowDocumentUri(worktreePath, leftCommit, filePath);
      const rightUri = shadowDocumentUri(worktreePath, request.commitSha, filePath);
      const title = `${filePath}: ${shortSha(leftCommit)} ↔ ${shortSha(request.commitSha)}`;

      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
      return { status: 'opened', message: '已打开 VS Code 差异视图。' };
    });
  } catch (error) {
    return { status: 'failed', message: `打开差异失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function ensureShadowDiffProviderRegistered(): vscode.Disposable {
  if (shadowDiffProviderDisposable) return shadowDiffProviderDisposable;
  shadowDiffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(SHADOW_DIFF_SCHEME, {
    async provideTextDocumentContent(uri) {
      const params = new URLSearchParams(uri.query);
      const worktreePath = params.get('worktree') ?? '';
      const commit = params.get('commit') ?? '';
      const filePath = normalizeGitRelativePath(params.get('path') ?? '');
      if (!worktreePath || !filePath || commit === EMPTY_DOCUMENT_COMMIT) return '';
      const blob = await readGitBlob(worktreePath, commit, filePath);
      return blob.toString('utf8');
    }
  });
  return shadowDiffProviderDisposable;
}

function shadowDocumentUri(worktreePath: string, commit: string, filePath: string): vscode.Uri {
  const query = new URLSearchParams({ worktree: worktreePath, commit, path: filePath });
  return vscode.Uri.from({
    scheme: SHADOW_DIFF_SCHEME,
    authority: 'checkpoint',
    path: `/${filePath}`,
    query: query.toString()
  });
}

async function readGitBlob(worktreePath: string, commit: string, filePath: string): Promise<Buffer> {
  const result = await runGit(worktreePath, ['show', `${commit}:${filePath}`], { allowExitCodes: [0, 128] });
  if (result.exitCode === 0) return result.stdout;
  return Buffer.from('');
}

async function resolveParentCommit(worktreePath: string, commitSha: string): Promise<string | undefined> {
  const result = await runGit(worktreePath, ['rev-parse', `${commitSha}^`], { allowExitCodes: [0, 128] });
  if (result.exitCode !== 0) return undefined;
  const parent = result.stdout.toString('utf8').trim();
  return parent || undefined;
}

async function fileChangedInCommit(worktreePath: string, commitSha: string, parentSha: string | undefined, filePath: string): Promise<boolean> {
  if (!parentSha) {
    const existsInCommit = await runGit(worktreePath, ['cat-file', '-e', `${commitSha}:${filePath}`], { allowExitCodes: [0, 128] });
    return existsInCommit.exitCode === 0;
  }
  const diff = await runGit(worktreePath, ['diff', '--quiet', parentSha, commitSha, '--', filePath], { allowExitCodes: [0, 1] });
  return diff.exitCode === 1;
}

function runGit(cwd: string, args: string[], options: { allowExitCodes?: number[] } = {}): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, GIT_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const exitCode = killed ? (code ?? 1) : (code ?? 0);
      const result = { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') };
      if (options.allowExitCodes?.includes(exitCode) || exitCode === 0) {
        resolve(result);
      } else {
        reject(new Error(result.stderr || `git ${args.join(' ')} failed with exit code ${exitCode}`));
      }
    });
  });
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeGitRelativePath(input: string): string {
  const normalized = input.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return '';
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) return '';
  return parts.join('/');
}

function shortSha(sha: string): string {
  if (sha === EMPTY_DOCUMENT_COMMIT) return 'empty';
  return sha.slice(0, 8);
}
