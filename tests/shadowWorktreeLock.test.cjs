const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  static from(input) { return new MockUri(input.path || '/'); }
  static parse(value) { return new MockUri(value.replace(/^file:\/\//, '')); }
  toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
}

let workspaceFolders = [];
function installVscodeMock() {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      get workspaceFolders() { return workspaceFolders; },
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        stat: async (uri) => {
          const stat = await fs.stat(uri.fsPath);
          return { type: stat.isDirectory() ? 2 : 1 };
        },
        delete: (uri, options) => fs.rm(uri.fsPath, { recursive: !!options?.recursive, force: false }),
        readFile: (uri) => fs.readFile(uri.fsPath),
        writeFile: async (uri, data) => {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, data);
        }
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} })
    },
    commands: { executeCommand: async () => undefined },
    window: {
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mock;
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => { Module._load = originalLoad; };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function exists(target) { try { await fs.stat(target); return true; } catch { return false; } }
async function removeTempRoot(target) { await fs.rm(target, { recursive: true, force: true }); }

const restore = installVscodeMock();
process.on('exit', restore);

const { withShadowWorktreeLock } = require('../dist/extension/backend/capabilities/vscodeStorage/shadowWorktreeLock.js');
const shadowMaintenance = require('../dist/extension/backend/capabilities/vscodeStorage/shadowCheckpointMaintenance.js');
const { collectShadowWorktreeStats, deleteShadowWorktrees, cleanupUnusedShadowWorktrees } = shadowMaintenance;
const { restoreShadowCheckpoint } = require('../dist/extension/backend/capabilities/vscodeStorage/shadowCheckpoint.js');
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

test('same storageKey operations are serial and different keys can run in parallel', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shadow-lock-serial-'));
  try {
    const order = [];
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const p1 = withShadowWorktreeLock(tempRoot, 'repo-a', async () => {
      order.push('a1-start');
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push('a1-end');
    });
    await firstStarted.promise;

    let secondStarted = false;
    const p2 = withShadowWorktreeLock(tempRoot, 'repo-a', async () => {
      secondStarted = true;
      order.push('a2-start');
    });
    let otherStarted = false;
    const p3 = withShadowWorktreeLock(tempRoot, 'repo-b', async () => {
      otherStarted = true;
      order.push('b-start');
    });

    await delay(30);
    assert.equal(secondStarted, false, 'same key must wait');
    assert.equal(otherStarted, true, 'different key should not wait for repo-a');

    releaseFirst.resolve();
    await Promise.all([p1, p2, p3]);
    assert.ok(order.indexOf('a2-start') > order.indexOf('a1-end'));
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('stats and delete wait for in-progress same-key worktree mutation', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shadow-lock-maint-'));
  try {
    const releaseCreate = deferred();
    const createStarted = deferred();
    const create = withShadowWorktreeLock(tempRoot, 'repo-stats', async ({ worktreePath }) => {
      await fs.mkdir(worktreePath, { recursive: true });
      await fs.writeFile(path.join(worktreePath, 'partial.txt'), 'partial', 'utf8');
      createStarted.resolve();
      await releaseCreate.promise;
      await fs.writeFile(path.join(worktreePath, 'final.txt'), 'final', 'utf8');
    });
    await createStarted.promise;

    let statsResolved = false;
    const statsPromise = collectShadowWorktreeStats({ checkpointShadowWorktreesRootPath: tempRoot }).then((stats) => { statsResolved = true; return stats; });
    let deleteResolved = false;
    const deletePromise = deleteShadowWorktrees({ checkpointShadowWorktreesRootPath: tempRoot }, ['repo-stats']).then((result) => { deleteResolved = true; return result; });

    await delay(30);
    assert.equal(statsResolved, false, 'stats must wait for same-key mutation lock');
    assert.equal(deleteResolved, false, 'delete must wait for same-key mutation lock');
    assert.equal(await exists(path.join(tempRoot, 'repo-stats', 'partial.txt')), true);

    releaseCreate.resolve();
    const [, stats, deleted] = await Promise.all([create, statsPromise, deletePromise]);
    assert.ok(stats.length === 0 || stats[0].fileCount >= 2, 'stats should either run after delete or observe the completed worktree, never the partial one');
    assert.deepEqual(deleted.deletedStorageKeys, ['repo-stats']);
    assert.equal(await exists(path.join(tempRoot, 'repo-stats')), false);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('auto cleanup keeps stale worktree while checkpoint metadata references it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shadow-cleanup-ref-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    const worktree = path.join(paths.checkpointShadowWorktreesRootPath, 'repo-live');
    await makeWorktreeWithMtime(worktree, Date.now() - 10 * 24 * 60 * 60 * 1000);
    const state = createEmptyClientState();
    state.shadowRepositories.push({ id: 'shadow-live', storageKey: 'repo-live', createdAt: 1, updatedAt: 1 });
    state.checkpoints.push({
      id: 'checkpoint-live',
      conversationId: 'conversation-live',
      projectContextId: 'project-live',
      shadowRepositoryId: 'shadow-live',
      trigger: 'manual',
      status: 'created',
      projectUri: 'file:///project-live',
      projectDisplayPath: 'project-live',
      createdAt: 1,
      updatedAt: 1,
      commitSha: 'abc'
    });
    await clientStateStore.saveClientStateSkeletonToStores(paths, state);

    const result = await cleanupUnusedShadowWorktrees(paths, 1);
    assert.deepEqual(result.deletedStorageKeys, []);
    assert.equal(await exists(worktree), true);
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('auto cleanup skips stale candidate when it becomes active after stats', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shadow-cleanup-race-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    const worktree = path.join(paths.checkpointShadowWorktreesRootPath, 'repo-race');
    await makeWorktreeWithMtime(worktree, Date.now() - 10 * 24 * 60 * 60 * 1000);
    shadowMaintenance.__shadowCleanupTestHooks.afterCollectStaleCandidates = async (storageKeys) => {
      if (!storageKeys.includes('repo-race')) return;
      await makeWorktreeWithMtime(worktree, Date.now());
    };

    const result = await cleanupUnusedShadowWorktrees(paths, 1);
    assert.deepEqual(result.deletedStorageKeys, []);
    assert.equal(await exists(worktree), true);
  } finally {
    shadowMaintenance.__shadowCleanupTestHooks.afterCollectStaleCandidates = undefined;
    await removeTempRoot(tempRoot);
  }
});


test('auto cleanup deletes only true orphan that is still stale inside lock', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shadow-cleanup-orphan-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    const worktree = path.join(paths.checkpointShadowWorktreesRootPath, 'repo-orphan');
    await makeWorktreeWithMtime(worktree, Date.now() - 10 * 24 * 60 * 60 * 1000);

    const result = await cleanupUnusedShadowWorktrees(paths, 1);
    assert.deepEqual(result.deletedStorageKeys, ['repo-orphan']);
    assert.equal(await exists(worktree), false);
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('auto cleanup refuses to delete when metadata cannot be loaded', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shadow-cleanup-invalid-meta-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    const worktree = path.join(paths.checkpointShadowWorktreesRootPath, 'repo-invalid-meta');
    await makeWorktreeWithMtime(worktree, Date.now() - 10 * 24 * 60 * 60 * 1000);
    await clientStateStore.saveClientStateSkeletonToStores(paths, createEmptyClientState());
    await fs.writeFile(paths.shadowRepositoriesIndexUri.fsPath, '{bad-json', 'utf8');

    await assert.rejects(cleanupUnusedShadowWorktrees(paths, 1), /JSON|Unexpected|invalid/i);
    assert.equal(await exists(worktree), true);
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('damaged empty-directory manifest rejects restore before overwriting project files', { skip: !hasGitSync() }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shadow-manifest-'));
  try {
    const project = path.join(tempRoot, 'project');
    const shadowRoot = path.join(tempRoot, 'shadow');
    const worktree = path.join(shadowRoot, 'repo-manifest');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(project, 'file.txt'), 'original', 'utf8');

    await git(worktree, ['init']);
    await git(worktree, ['config', 'user.name', 'LimCode Test']);
    await git(worktree, ['config', 'user.email', 'limcode-test@example.invalid']);
    await fs.writeFile(path.join(worktree, 'file.txt'), 'snapshot', 'utf8');
    await fs.mkdir(path.join(worktree, '.limcode'), { recursive: true });
    await fs.writeFile(path.join(worktree, '.limcode', 'checkpoint-empty-directories.json'), '{bad-json', 'utf8');
    await git(worktree, ['add', '-A']);
    await git(worktree, ['commit', '-m', 'snapshot']);
    const { stdout } = await git(worktree, ['rev-parse', 'HEAD']);
    const commitSha = stdout.trim();

    workspaceFolders = [{ uri: MockUri.file(project), name: 'project', index: 0 }];
    const result = await restoreShadowCheckpoint({ checkpointShadowWorktreesRootPath: shadowRoot }, {
      checkpointId: 'checkpoint-a',
      conversationId: 'conversation-a',
      shadowRepositoryStorageKey: 'repo-manifest',
      commitSha,
      projectUri: MockUri.file(project).toString(),
      policy: {
        id: 'policy-a',
        name: 'Policy',
        enabled: true,
        initialSnapshotMaxBytes: 1024 * 1024,
        preserveEmptyDirectories: true,
        useGitignore: false,
        skipPatterns: [],
        triggers: {},
        toolTriggers: {},
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /manifest|JSON|invalid|失败/i);
    assert.equal(await fs.readFile(path.join(project, 'file.txt'), 'utf8'), 'original');
  } finally {
    workspaceFolders = [];
    await removeTempRoot(tempRoot);
  }
});

function hasGitSync() {
  try {
    require('node:child_process').execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true });
}

async function makeWorktreeWithMtime(worktree, mtimeMs) {
  await fs.mkdir(worktree, { recursive: true });
  const file = path.join(worktree, 'file.txt');
  await fs.writeFile(file, `mtime:${mtimeMs}`, 'utf8');
  const date = new Date(mtimeMs);
  await fs.utimes(file, date, date);
}
