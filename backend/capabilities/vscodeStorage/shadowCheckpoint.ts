import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type { CheckpointGitStatusRecord, CheckpointRecord, CheckpointSkipReason, CheckpointRestorePayload, ShadowCheckpointRestoreResult } from '../../../shared/protocol';
import type { CheckpointPolicyRecord } from '../../../shared/protocol';
import type { ShadowCheckpointCreateRequest } from '../types';
import type { StoragePaths } from './clientStateStore';
import { emptyDirectoryManifest, workspaceContainsProject } from '../../world/modules/checkpoint/policy';

const EMPTY_DIRECTORY_MANIFEST_RELATIVE_PATH = '.limcode/checkpoint-empty-directories.json';

interface SourceEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
}

interface SourceSnapshot {
  files: SourceEntry[];
  emptyDirectories: string[];
  byteCount: number;
}

interface GitSourceContext {
  cwd: string;
  baseArgs: string[];
}

interface GitRunOptions {
  allowExitCodes?: number[];
  input?: string | Buffer;
}

class GitUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GitUnavailableError';
  }
}

export async function detectSystemGit(cwd = process.cwd()): Promise<CheckpointGitStatusRecord> {
  const checkedAt = Date.now();
  try {
    const result = await runGit(cwd, ['--version']);
    return {
      available: true,
      checkedAt,
      version: (result.stdout.trim() || result.stderr.trim() || 'git').replace(/^git version\s*/i, 'git ')
    };
  } catch (error) {
    return {
      available: false,
      checkedAt,
      message: gitUnavailableMessage(error)
    };
  }
}

export async function createShadowCheckpoint(paths: StoragePaths, request: ShadowCheckpointCreateRequest): Promise<CheckpointRecord> {
  const now = Date.now();
  const base = baseRecord(request, now);
  const projectPath = fsPathFromProjectUri(request.projectUri);
  if (!projectPath) return skipped(base, 'unsupported_project_uri', '当前只支持本地 file:// 项目归属。');

  const workspaceFolderUris = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString());
  if (!workspaceContainsProject(workspaceFolderUris, request.projectUri)) {
    return skipped(base, 'workspace_not_containing_project', '当前 VS Code 工作区未包含对话归属文件夹。');
  }

  let snapshot: SourceSnapshot | undefined;
  try {
    await ensureSystemGitAvailable(projectPath);
    const worktreePath = path.join(paths.checkpointShadowWorktreesRootPath, request.shadowRepositoryStorageKey);
    const isInitial = !(await exists(path.join(worktreePath, '.git')));
    snapshot = await scanSourceWithGit(paths, projectPath, worktreePath, isInitial, request.policy);
    if (isInitial && snapshot.byteCount > request.policy.initialSnapshotMaxBytes) {
      return skipped(base, 'initial_size_exceeded', `项目文件大小 ${snapshot.byteCount} 超过初始存档阈值 ${request.policy.initialSnapshotMaxBytes}。`, snapshot);
    }

    await fs.mkdir(worktreePath, { recursive: true });
    await ensureGitRepository(worktreePath);
    await syncWorktree(worktreePath, snapshot, request.policy.preserveEmptyDirectories);
    const commit = await commitWorktree(worktreePath, request);
    if (!commit.created) {
      if (commit.sha) {
        return {
          ...base,
          status: 'created',
          commitSha: commit.sha,
          message: '项目内容没有变化，复用上一存档快照。',
          fileCount: snapshot.files.length,
          byteCount: snapshot.byteCount,
          emptyDirectoryCount: snapshot.emptyDirectories.length
        };
      }
      return skipped(base, 'no_changes', '项目内容没有变化，未创建新存档点。', snapshot);
    }
    return {
      ...base,
      status: 'created',
      commitSha: commit.sha,
      message: '已创建存档点。',
      fileCount: snapshot.files.length,
      byteCount: snapshot.byteCount,
      emptyDirectoryCount: snapshot.emptyDirectories.length
    };
  } catch (error) {
    const reason: CheckpointSkipReason = isGitUnavailable(error) ? 'git_unavailable' : 'io_error';
    return skipped(base, reason, error instanceof Error ? error.message : String(error), snapshot);
  }
}

export async function restoreShadowCheckpoint(paths: StoragePaths, request: CheckpointRestorePayload): Promise<ShadowCheckpointRestoreResult> {
  const projectPath = fsPathFromProjectUri(request.projectUri);
  if (!projectPath) return { status: 'failed', message: '当前只支持本地 file:// 项目归属，无法回档。' };

  const workspaceFolderUris = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString());
  if (!workspaceContainsProject(workspaceFolderUris, request.projectUri)) {
    return { status: 'failed', message: '当前 VS Code 工作区未包含对话归属文件夹，无法回档。' };
  }
  if (!request.commitSha) return { status: 'failed', message: '该存档点没有可回档的快照。' };

  const worktreePath = path.join(paths.checkpointShadowWorktreesRootPath, request.shadowRepositoryStorageKey);
  if (!(await exists(path.join(worktreePath, '.git')))) {
    return { status: 'failed', message: 'shadow 仓库已被删除，无法回档。' };
  }

  let originalHead: string | undefined;
  try {
    await ensureSystemGitAvailable(projectPath);
    const commitCheck = await runGit(worktreePath, ['cat-file', '-e', `${request.commitSha}^{commit}`], { allowExitCodes: [0, 128] });
    if (commitCheck.exitCode !== 0) return { status: 'failed', message: '存档点对应的快照已不存在，无法回档。' };

    originalHead = (await runGit(worktreePath, ['rev-parse', 'HEAD'], { allowExitCodes: [0, 128] })).stdout.trim() || undefined;
    await runGit(worktreePath, ['checkout', '-f', request.commitSha]);

    const targetFiles = await listShadowTrackedFiles(worktreePath);
    const targetSet = new Set(targetFiles);

    const tempRoot = await fs.mkdtemp(path.join(paths.checkpointShadowWorktreesRootPath, '.checkpoint-restore-'));
    let removedFileCount = 0;
    try {
      const excludeFilePath = await writeCheckpointExcludeFile(tempRoot, request.policy.skipPatterns);
      const source = await createGitSourceContext(projectPath, tempRoot);
      const visibleFiles = await listSourceVisibleFiles(source, projectPath, request.policy.useGitignore, excludeFilePath, request.policy.skipPatterns);
      for (const relativePath of visibleFiles) {
        if (targetSet.has(relativePath)) continue;
        await fs.rm(toAbsolutePath(projectPath, relativePath), { force: true }).catch(() => undefined);
        removedFileCount += 1;
      }
      for (const relativePath of targetFiles) {
        const sourceFile = toAbsolutePath(worktreePath, relativePath);
        const destFile = toAbsolutePath(projectPath, relativePath);
        await fs.mkdir(path.dirname(destFile), { recursive: true });
        await fs.copyFile(sourceFile, destFile);
      }
      if (request.policy.preserveEmptyDirectories) {
        for (const relativeDir of await readEmptyDirectoryManifest(worktreePath)) {
          await fs.mkdir(toAbsolutePath(projectPath, relativeDir), { recursive: true }).catch(() => undefined);
        }
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      status: 'restored',
      message: `已回档 ${targetFiles.length} 个文件${removedFileCount ? `，并移除 ${removedFileCount} 个存档后新增的文件` : ''}。`,
      restoredFileCount: targetFiles.length,
      removedFileCount
    };
  } catch (error) {
    const reason = isGitUnavailable(error) ? '未检测到系统 git 命令，请安装 Git 并确保 git 位于 PATH。' : (error instanceof Error ? error.message : String(error));
    return { status: 'failed', message: `回档失败：${reason}` };
  } finally {
    if (originalHead) await runGit(worktreePath, ['checkout', '-f', originalHead]).catch(() => undefined);
  }
}

async function readEmptyDirectoryManifest(worktreePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(worktreePath, ...EMPTY_DIRECTORY_MANIFEST_RELATIVE_PATH.split('/')), 'utf8');
    const parsed = JSON.parse(raw) as { emptyDirectories?: unknown };
    return Array.isArray(parsed.emptyDirectories)
      ? parsed.emptyDirectories.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function baseRecord(request: ShadowCheckpointCreateRequest, now: number): CheckpointRecord {
  return {
    id: request.checkpointId,
    conversationId: request.conversationId,
    projectContextId: request.projectContextId,
    shadowRepositoryId: request.shadowRepositoryId,
    trigger: request.trigger,
    status: 'skipped',
    projectUri: request.projectUri,
    projectDisplayPath: request.projectDisplayPath,
    createdAt: now,
    updatedAt: now
  };
}

function skipped(record: CheckpointRecord, skipReason: CheckpointSkipReason, message: string, snapshot?: SourceSnapshot): CheckpointRecord {
  return {
    ...record,
    status: skipReason === 'git_unavailable' || skipReason === 'io_error' ? 'failed' : 'skipped',
    skipReason,
    message,
    ...(snapshot ? {
      fileCount: snapshot.files.length,
      byteCount: snapshot.byteCount,
      emptyDirectoryCount: snapshot.emptyDirectories.length
    } : {})
  };
}

async function ensureSystemGitAvailable(cwd: string): Promise<void> {
  const status = await detectSystemGit(cwd);
  if (status.available) return;
  throw new GitUnavailableError(status.message ?? '未检测到系统 git 命令，请安装 Git 并确保 git 位于 PATH。');
}

async function scanSourceWithGit(
  paths: StoragePaths,
  projectPath: string,
  worktreePath: string,
  isInitial: boolean,
  policy: CheckpointPolicyRecord
): Promise<SourceSnapshot> {
  await fs.mkdir(paths.checkpointShadowWorktreesRootPath, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(paths.checkpointShadowWorktreesRootPath, '.checkpoint-scan-'));
  try {
    const excludeFilePath = await writeCheckpointExcludeFile(tempRoot, policy.skipPatterns);
    const source = await createGitSourceContext(projectPath, tempRoot);
    const sourceVisibleFiles = await listSourceVisibleFiles(source, projectPath, policy.useGitignore, excludeFilePath, policy.skipPatterns);
    const shadowTrackedFiles = isInitial ? [] : await listShadowTrackedFiles(worktreePath);
    const mergedFiles = await mergeSourceVisibleAndShadowTrackedFiles(projectPath, sourceVisibleFiles, shadowTrackedFiles);
    const files = await buildSourceFileEntries(projectPath, mergedFiles);
    const emptyDirectories = policy.preserveEmptyDirectories
      ? await discoverEmptyDirectories(source, projectPath, files, policy.useGitignore, excludeFilePath)
      : [];

    return {
      files,
      emptyDirectories,
      byteCount: files.reduce((total, entry) => total + entry.size, 0)
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createGitSourceContext(projectPath: string, tempRoot: string): Promise<GitSourceContext> {
  if (await exists(path.join(projectPath, '.git'))) {
    return { cwd: projectPath, baseArgs: [] };
  }

  const gitDir = path.join(tempRoot, 'source.git');
  await runGit(projectPath, ['init', '--bare', gitDir]);
  // 用户选择的项目目录可能只是某个更大 Git 仓库里的子目录，甚至被父级 .gitignore 整体忽略。
  // checkpoint 的边界应是当前 projectPath，而不是父仓库；因此当 projectPath 自身不是 Git root 时，
  // 使用临时 bare git + --work-tree 隔离父级仓库配置和 ignore 规则。
  return {
    cwd: projectPath,
    baseArgs: [`--git-dir=${gitDir}`, `--work-tree=${projectPath}`]
  };
}

async function writeCheckpointExcludeFile(tempRoot: string, skipPatterns: readonly string[]): Promise<string> {
  const excludeFilePath = path.join(tempRoot, 'limcode-checkpoint-exclude');
  const lines = [
    ...skipPatterns.map((pattern) => pattern.replace(/\r?\n/g, '')).filter((pattern) => pattern.trim()),
    '.git/'
  ];
  await fs.writeFile(excludeFilePath, `${lines.join('\n')}\n`, 'utf8');
  return excludeFilePath;
}

async function listSourceVisibleFiles(
  source: GitSourceContext,
  projectPath: string,
  useGitignore: boolean,
  excludeFilePath: string,
  skipPatterns: readonly string[]
): Promise<string[]> {
  const result = await runSourceGit(source, sourceLsFilesArgs(['-c', '-o'], useGitignore, excludeFilePath, ['--', '.']));
  const gitFiles = parseGitPathList(result.stdout).filter((relativePath) => !relativePath.endsWith('/'));
  const fsFiles = await filterGitIgnoredFiles(source, await listFilesystemFiles(projectPath, skipPatterns), useGitignore);
  return uniqueSortedGitPaths([...gitFiles, ...fsFiles]);
}

async function listFilesystemFiles(rootPath: string, skipPatterns: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
    const children = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.name === '.git') continue;
      const relativePath = joinRelativePath(relativeDirectory, child.name);
      if (!relativePath || matchesSkipPattern(relativePath, child.isDirectory(), skipPatterns)) continue;
      const absolutePath = path.join(directoryPath, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (child.isFile()) files.push(relativePath);
    }
  }
  await visit(rootPath, '');
  return uniqueSortedGitPaths(files);
}

async function filterGitIgnoredFiles(source: GitSourceContext, files: readonly string[], useGitignore: boolean): Promise<string[]> {
  if (!useGitignore || files.length === 0) return [...files];
  const ignored = new Set<string>();
  const chunkSize = 500;
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunk = files.slice(index, index + chunkSize);
    const result = await runSourceGit(source, ['check-ignore', '--no-index', '-z', '--stdin'], {
      allowExitCodes: [0, 1, 128],
      input: `${chunk.join('\0')}\0`
    }).catch(() => undefined);
    if (!result || result.exitCode !== 0) continue;
    for (const relativePath of parseGitPathList(result.stdout)) ignored.add(relativePath);
  }
  return files.filter((file) => !ignored.has(file));
}

function matchesSkipPattern(relativePath: string, isDirectory: boolean, patterns: readonly string[]): boolean {
  const normalized = normalizeGitRelativePath(relativePath);
  if (!normalized) return true;
  for (const raw of patterns) {
    const pattern = normalizeSkipPattern(raw);
    if (!pattern) continue;
    if (skipPatternMatches(pattern, normalized, isDirectory)) return true;
  }
  return false;
}

function normalizeSkipPattern(pattern: string): string | undefined {
  const normalized = pattern.replace(/\r?\n/g, '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
  return normalized || undefined;
}

function skipPatternMatches(pattern: string, relativePath: string, isDirectory: boolean): boolean {
  const directoryPattern = pattern.endsWith('/');
  const trimmedPattern = pattern.replace(/\/+$/, '');
  if (!trimmedPattern) return false;
  if (!pattern.includes('*') && !pattern.includes('?')) {
    if (directoryPattern) return relativePath === trimmedPattern || relativePath.startsWith(`${trimmedPattern}/`) || relativePath.endsWith(`/${trimmedPattern}`) || relativePath.includes(`/${trimmedPattern}/`);
    return relativePath === trimmedPattern || path.posix.basename(relativePath) === trimmedPattern || (isDirectory && relativePath.startsWith(`${trimmedPattern}/`));
  }
  const regex = globPatternToRegExp(pattern);
  return regex.test(relativePath) || (isDirectory && regex.test(`${relativePath}/`));
}

function globPatternToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`(^|/)${source}($|/)`);
}

async function listShadowTrackedFiles(worktreePath: string): Promise<string[]> {
  if (!(await exists(path.join(worktreePath, '.git')))) return [];
  const result = await runGit(worktreePath, ['ls-files', '-z']);
  return uniqueSortedGitPaths(parseGitPathList(result.stdout).filter((relativePath) => relativePath !== EMPTY_DIRECTORY_MANIFEST_RELATIVE_PATH));
}

async function mergeSourceVisibleAndShadowTrackedFiles(
  projectPath: string,
  sourceVisibleFiles: readonly string[],
  shadowTrackedFiles: readonly string[]
): Promise<string[]> {
  const merged = new Set(sourceVisibleFiles);
  for (const relativePath of shadowTrackedFiles) {
    if (merged.has(relativePath)) continue;
    const stat = await fs.stat(toAbsolutePath(projectPath, relativePath)).catch(() => undefined);
    if (stat?.isFile()) merged.add(relativePath);
  }
  return [...merged].sort(compareRelativePath);
}

async function buildSourceFileEntries(projectPath: string, relativePaths: readonly string[]): Promise<SourceEntry[]> {
  const files: SourceEntry[] = [];
  for (const relativePath of relativePaths) {
    const absolutePath = toAbsolutePath(projectPath, relativePath);
    const stat = await fs.stat(absolutePath).catch(() => undefined);
    if (!stat?.isFile()) continue;
    files.push({ absolutePath, relativePath, size: stat.size });
  }
  return files.sort((left, right) => compareRelativePath(left.relativePath, right.relativePath));
}

async function discoverEmptyDirectories(
  source: GitSourceContext,
  projectPath: string,
  files: readonly SourceEntry[],
  useGitignore: boolean,
  excludeFilePath: string
): Promise<string[]> {
  const directoriesWithIncludedFiles = directoriesWithIncludedDescendants(files.map((file) => file.relativePath));
  const emptyDirectories = new Set<string>();
  const visibilityCache = new Map<string, boolean>();

  async function isDirectoryVisible(relativePath: string): Promise<boolean> {
    const normalized = normalizeGitRelativePath(relativePath);
    if (!normalized || normalized === '.git' || normalized.startsWith('.git/')) return false;
    const cached = visibilityCache.get(normalized);
    if (cached !== undefined) return cached;
    const result = await runSourceGit(source, sourceLsFilesArgs(['-o', '--directory'], useGitignore, excludeFilePath, ['--', normalized]), { allowExitCodes: [0] });
    const visible = parseGitPathList(result.stdout).length > 0;
    visibilityCache.set(normalized, visible);
    return visible;
  }

  async function visitDirectoryWithIncludedDescendants(directoryPath: string, relativePath: string): Promise<void> {
    const children = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || child.name === '.git') continue;
      const childRelativePath = joinRelativePath(relativePath, child.name);
      const childAbsolutePath = path.join(directoryPath, child.name);
      if (directoriesWithIncludedFiles.has(childRelativePath)) {
        await visitDirectoryWithIncludedDescendants(childAbsolutePath, childRelativePath);
      } else {
        await visitPotentialEmptyDirectory(childAbsolutePath, childRelativePath);
      }
    }
  }

  async function visitPotentialEmptyDirectory(directoryPath: string, relativePath: string): Promise<boolean> {
    if (!(await isDirectoryVisible(relativePath))) return false;
    const children = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    let hasKeptChildDirectory = false;
    for (const child of children) {
      if (!child.isDirectory() || child.name === '.git') continue;
      const childRelativePath = joinRelativePath(relativePath, child.name);
      const childAbsolutePath = path.join(directoryPath, child.name);
      const childKept = directoriesWithIncludedFiles.has(childRelativePath)
        ? (await visitDirectoryWithIncludedDescendants(childAbsolutePath, childRelativePath), true)
        : await visitPotentialEmptyDirectory(childAbsolutePath, childRelativePath);
      if (childKept) hasKeptChildDirectory = true;
    }
    if (!hasKeptChildDirectory) emptyDirectories.add(relativePath);
    return true;
  }

  await visitDirectoryWithIncludedDescendants(projectPath, '');
  return [...emptyDirectories].sort(compareRelativePath);
}

function directoriesWithIncludedDescendants(relativeFiles: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const relativeFile of relativeFiles) {
    let directory = path.posix.dirname(relativeFile);
    while (directory && directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return directories;
}

async function syncWorktree(worktreePath: string, snapshot: SourceSnapshot, preserveEmptyDirectories: boolean): Promise<void> {
  await clearWorktree(worktreePath);
  for (const file of snapshot.files) {
    const target = toAbsolutePath(worktreePath, file.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file.absolutePath, target);
  }
  if (preserveEmptyDirectories) {
    const manifestPath = toAbsolutePath(worktreePath, EMPTY_DIRECTORY_MANIFEST_RELATIVE_PATH);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(emptyDirectoryManifest(snapshot.emptyDirectories), null, 2), 'utf8');
  }
}

async function clearWorktree(worktreePath: string): Promise<void> {
  const children = await fs.readdir(worktreePath, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    if (child.name === '.git') continue;
    await fs.rm(path.join(worktreePath, child.name), { recursive: true, force: true });
  }
}

async function ensureGitRepository(worktreePath: string): Promise<void> {
  if (await exists(path.join(worktreePath, '.git'))) return;
  await runGit(worktreePath, ['init']);
}

async function commitWorktree(worktreePath: string, request: ShadowCheckpointCreateRequest): Promise<{ created: boolean; sha?: string }> {
  await runGit(worktreePath, ['add', '-A', '-f']);
  const diff = await runGit(worktreePath, ['diff', '--cached', '--quiet'], { allowExitCodes: [0, 1] });
  if (diff.exitCode === 0) {
    const head = await runGit(worktreePath, ['rev-parse', 'HEAD'], { allowExitCodes: [0, 128] });
    const sha = head.exitCode === 0 ? head.stdout.trim() : '';
    return { created: false, ...(sha ? { sha } : {}) };
  }
  await runGit(worktreePath, [
    '-c', 'user.name=LimCode Checkpoint',
    '-c', 'user.email=limcode-checkpoint@example.invalid',
    'commit',
    '-m',
    `checkpoint: ${request.trigger} ${request.checkpointId}`
  ]);
  const rev = await runGit(worktreePath, ['rev-parse', 'HEAD']);
  return { created: true, sha: rev.stdout.trim() };
}

function sourceLsFilesArgs(modes: string[], useGitignore: boolean, excludeFilePath: string, suffix: string[]): string[] {
  return [
    'ls-files',
    ...modes,
    '-z',
    ...(useGitignore ? ['--exclude-standard'] : []),
    `--exclude-from=${excludeFilePath}`,
    ...suffix
  ];
}

async function runSourceGit(source: GitSourceContext, args: string[], options: GitRunOptions = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runGit(source.cwd, [...source.baseArgs, ...args], options);
}

async function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      const code = exitCode ?? 1;
      if (code === 0 || options.allowExitCodes?.includes(code)) resolve({ exitCode: code, stdout, stderr });
      else reject(new Error(stderr.trim() || `git ${args.join(' ')} exited with ${code}`));
    });
  });
}

function parseGitPathList(output: string): string[] {
  return output
    .split('\0')
    .map(normalizeGitRelativePath)
    .filter((relativePath): relativePath is string => !!relativePath);
}

function uniqueSortedGitPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((relativePath) => relativePath !== EMPTY_DIRECTORY_MANIFEST_RELATIVE_PATH))]
    .sort(compareRelativePath);
}

function normalizeGitRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return undefined;
  return normalized;
}

function joinRelativePath(parent: string, childName: string): string {
  return normalizeGitRelativePath(parent ? `${parent}/${childName}` : childName) ?? '';
}

function toAbsolutePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}

function compareRelativePath(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function fsPathFromProjectUri(projectUri: string): string | undefined {
  try {
    if (!projectUri.startsWith('file:')) return undefined;
    return vscode.Uri.parse(projectUri).fsPath;
  } catch {
    return undefined;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isGitUnavailable(error: unknown): boolean {
  return error instanceof GitUnavailableError
    || (!!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function gitUnavailableMessage(error: unknown): string {
  if (!!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
    return '未检测到系统 git 命令，请安装 Git 并确保 git 位于 PATH。';
  }
  return error instanceof Error ? error.message : String(error);
}
