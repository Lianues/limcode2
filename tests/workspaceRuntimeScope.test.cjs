const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { spawn } = require('node:child_process');

class MockUri {
  constructor(fsPath, scheme = 'file') {
    this.scheme = scheme;
    this.fsPath = scheme === 'file' ? path.resolve(fsPath) : fsPath;
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments), base.scheme); }
  toString() { return this.scheme === 'file' ? `file://${this.path}` : `${this.scheme}:${this.path}`; }
}

const vscodeMock = {
  Uri: MockUri,
  FileType: { File: 1, Directory: 2 },
  workspace: {
    fs: {
      createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
      readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
        .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
      readFile: (uri) => fs.readFile(uri.fsPath),
      writeFile: async (uri, data) => {
        await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.writeFile(uri.fsPath, data);
      },
      stat: async (uri) => {
        const stat = await fs.stat(uri.fsPath);
        return { type: stat.isDirectory() ? 2 : 1 };
      },
      copy: (source, target, options) => fs.cp(source.fsPath, target.fsPath, {
        recursive: true,
        force: !!options?.overwrite
      }),
      delete: (uri, options) => fs.rm(uri.fsPath, { recursive: !!options?.recursive, force: false })
    }
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  createWorkspaceScopeIdentity,
  resolveWorkspaceRuntimeRoot,
  workspaceScopedRuntimeRoot
} = require('../dist/extension/backend/capabilities/vscodeStorage/workspaceScope.js');
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { copyStorageRootForMigration } = require('../dist/extension/backend/capabilities/vscodeStorage/migration.js');

function folderScope(...folders) {
  return createWorkspaceScopeIdentity({ workspaceFolderUris: folders.map(MockUri.file) });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

function startLegacyOwnerChild(modulePath, rootPath, workspacePath) {
  const script = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
class Uri {
  constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
  static file(fsPath) { return new Uri(fsPath); }
  static joinPath(base, ...segments) { return new Uri(path.join(base.fsPath, ...segments)); }
  toString() { return 'file://' + this.path; }
}
const vscode = {
  Uri,
  FileType: { File: 1, Directory: 2 },
  workspace: { fs: {
    createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
    readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
    readFile: (uri) => fs.readFile(uri.fsPath),
    writeFile: async (uri, data) => { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, data); },
    stat: async (uri) => { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? 2 : 1 }; },
    delete: (uri, options) => fs.rm(uri.fsPath, { recursive: !!options?.recursive, force: false })
  } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { createWorkspaceScopeIdentity, resolveWorkspaceRuntimeRoot } = require(process.argv[1]);
const root = Uri.file(process.argv[2]);
const scope = createWorkspaceScopeIdentity({ workspaceFolderUris: [Uri.file(process.argv[3])] });
process.send({ type: 'ready' });
process.on('message', async (message) => {
  if (message !== 'go') return;
  try {
    const runtime = await resolveWorkspaceRuntimeRoot(root, scope);
    process.send({ type: 'result', runtimePath: runtime.fsPath, scopeKey: scope.scopeKey });
  } catch (error) {
    process.send({ type: 'error', message: error instanceof Error ? error.stack : String(error) });
  } finally {
    process.disconnect();
  }
});
`;
  const child = spawn(process.execPath, ['-e', script, modulePath, rootPath, workspacePath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let readyResolve;
  let readyReject;
  let resultResolve;
  let resultReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  let completed = false;
  child.on('message', (message) => {
    if (message?.type === 'ready') readyResolve();
    if (message?.type === 'result') { completed = true; resultResolve(message); }
    if (message?.type === 'error') { completed = true; resultReject(new Error(message.message)); }
  });
  child.on('error', (error) => { readyReject(error); resultReject(error); });
  child.on('exit', (code) => {
    if (code !== 0 || !completed) {
      const error = new Error(`legacy owner child exited code=${code}: ${stderr}`);
      readyReject(error);
      resultReject(error);
    }
  });
  return { child, ready, result };
}

test('workspace scope prefers saved workspace file and folder identity is order-independent', () => {
  const folderA = MockUri.file('/workspace/a');
  const folderB = MockUri.file('/workspace/b');
  const workspaceFile = MockUri.file('/workspaces/project.code-workspace');
  const byFileA = createWorkspaceScopeIdentity({ workspaceFileUri: workspaceFile, workspaceFolderUris: [folderA] });
  const byFileB = createWorkspaceScopeIdentity({ workspaceFileUri: workspaceFile, workspaceFolderUris: [folderB] });
  assert.equal(byFileA.scopeKey, byFileB.scopeKey);
  assert.equal(byFileA.source, 'workspaceFile');
  assert.equal(byFileA.canClaimLegacy, true);

  const ordered = createWorkspaceScopeIdentity({ workspaceFolderUris: [folderA, folderB, folderA] });
  const reversed = createWorkspaceScopeIdentity({ workspaceFolderUris: [folderB, folderA] });
  assert.equal(ordered.scopeKey, reversed.scopeKey);
  assert.equal(ordered.scopeKey.length, 64);
  assert.doesNotMatch(ordered.scopeKey, /workspace/i);

  const untitled = createWorkspaceScopeIdentity({
    workspaceFileUri: new MockUri('/Untitled-1', 'untitled'),
    workspaceFolderUris: [folderA]
  });
  assert.equal(untitled.scopeKey, folderScope('/workspace/a').scopeKey);
});

test('different workspaces isolate runtime indexes while sharing global configuration settings', () => {
  const configurationRoot = MockUri.file('/limcode-data');
  const scopeA = folderScope('/workspace/a');
  const scopeB = folderScope('/workspace/b');
  const pathsA = createVscodeStoragePaths(workspaceScopedRuntimeRoot(configurationRoot, scopeA.scopeKey), configurationRoot);
  const pathsB = createVscodeStoragePaths(workspaceScopedRuntimeRoot(configurationRoot, scopeB.scopeKey), configurationRoot);

  assert.notEqual(pathsA.conversationsIndexPath, pathsB.conversationsIndexPath);
  assert.notEqual(pathsA.clientStateSkeletonRootPath, pathsB.clientStateSkeletonRootPath);
  assert.notEqual(pathsA.conversationSettingsRootUri.fsPath, pathsB.conversationSettingsRootUri.fsPath);
  assert.equal(pathsA.settingsRootPath, pathsB.settingsRootPath);
  assert.equal(pathsA.llmSettingsPath, pathsB.llmSettingsPath);
  assert.equal(pathsA.globalStoragePath, pathsB.globalStoragePath);
});

test('legacy runtime is atomically owned by exactly one non-empty workspace', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-legacy-owner-'));
  try {
    await fs.mkdir(path.join(tempRoot, 'agents'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'agents', 'legacy.json'), '{}');
    const root = MockUri.file(tempRoot);
    const scopeA = folderScope(path.join(tempRoot, 'workspace-a'));
    const scopeB = folderScope(path.join(tempRoot, 'workspace-b'));
    const [runtimeA, runtimeB] = await Promise.all([
      resolveWorkspaceRuntimeRoot(root, scopeA),
      resolveWorkspaceRuntimeRoot(root, scopeB)
    ]);

    assert.equal([runtimeA.fsPath, runtimeB.fsPath].filter((candidate) => candidate === root.fsPath).length, 1);
    const winner = runtimeA.fsPath === root.fsPath ? scopeA : scopeB;
    const loser = winner === scopeA ? scopeB : scopeA;
    assert.equal((await resolveWorkspaceRuntimeRoot(root, winner)).fsPath, root.fsPath);
    assert.equal(
      (await resolveWorkspaceRuntimeRoot(root, loser)).fsPath,
      workspaceScopedRuntimeRoot(root, loser.scopeKey).fsPath
    );

    const ownerPath = path.join(tempRoot, '.limcode-workspace-runtimes', 'legacy-owner.json');
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    assert.equal(owner.scopeKey, winner.scopeKey);
    assert.equal(owner.scopeKey.length, 64);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('legacy owner competition is atomic across real child processes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-legacy-child-race-'));
  const modulePath = require.resolve('../dist/extension/backend/capabilities/vscodeStorage/workspaceScope.js');
  const childA = startLegacyOwnerChild(modulePath, tempRoot, path.join(tempRoot, 'workspace-a'));
  const childB = startLegacyOwnerChild(modulePath, tempRoot, path.join(tempRoot, 'workspace-b'));
  try {
    await fs.mkdir(path.join(tempRoot, 'agents'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'agents', 'legacy.json'), '{}');
    await Promise.all([childA.ready, childB.ready]);
    childA.child.send('go');
    childB.child.send('go');
    const results = await Promise.all([childA.result, childB.result]);

    assert.equal(results.filter((result) => path.resolve(result.runtimePath) === path.resolve(tempRoot)).length, 1);
    const owner = JSON.parse(await fs.readFile(path.join(tempRoot, '.limcode-workspace-runtimes', 'legacy-owner.json'), 'utf8'));
    assert.equal(owner.scopeKey, results.find((result) => path.resolve(result.runtimePath) === path.resolve(tempRoot)).scopeKey);
  } finally {
    childA.child.kill();
    childB.child.kill();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('legacy conversation-only settings are sufficient for non-empty workspace ownership', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-legacy-settings-'));
  try {
    await fs.mkdir(path.join(tempRoot, 'settings'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'settings', 'conversation-default-llm.json'), '{}');
    const root = MockUri.file(tempRoot);
    const scope = folderScope(path.join(tempRoot, 'workspace'));
    assert.equal((await resolveWorkspaceRuntimeRoot(root, scope)).fsPath, root.fsPath);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('empty windows never claim legacy data and fresh installs remain independently scoped', async () => {
  const legacyRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-empty-'));
  const freshRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-fresh-'));
  try {
    await fs.mkdir(path.join(legacyRootPath, 'conversations'), { recursive: true });
    await fs.writeFile(path.join(legacyRootPath, 'conversations', 'index.json'), '{}');
    const legacyRoot = MockUri.file(legacyRootPath);
    const empty = createWorkspaceScopeIdentity({ storageUri: MockUri.file(path.join(legacyRootPath, 'window-storage')) });
    const emptyRuntime = await resolveWorkspaceRuntimeRoot(legacyRoot, empty);
    assert.equal(emptyRuntime.fsPath, workspaceScopedRuntimeRoot(legacyRoot, empty.scopeKey).fsPath);
    assert.equal(await exists(path.join(legacyRootPath, '.limcode-workspace-runtimes', 'legacy-owner.json')), false);

    const realWorkspace = folderScope(path.join(legacyRootPath, 'workspace'));
    assert.equal((await resolveWorkspaceRuntimeRoot(legacyRoot, realWorkspace)).fsPath, legacyRoot.fsPath);

    const freshRoot = MockUri.file(freshRootPath);
    const scopeA = folderScope('/fresh/a');
    const scopeB = folderScope('/fresh/b');
    const [freshA, freshB] = await Promise.all([
      resolveWorkspaceRuntimeRoot(freshRoot, scopeA),
      resolveWorkspaceRuntimeRoot(freshRoot, scopeB)
    ]);
    assert.notEqual(freshA.fsPath, freshB.fsPath);
    assert.equal(await exists(path.join(freshRootPath, '.limcode-workspace-runtimes', 'legacy-owner.json')), false);
  } finally {
    await fs.rm(legacyRootPath, { recursive: true, force: true });
    await fs.rm(freshRootPath, { recursive: true, force: true });
  }
});

test('data-root migration includes owner metadata and all scoped runtime trees', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-migration-'));
  try {
    const source = MockUri.file(path.join(tempRoot, 'source'));
    const target = MockUri.file(path.join(tempRoot, 'target'));
    const scope = folderScope('/migration/workspace');
    const scoped = workspaceScopedRuntimeRoot(source, scope.scopeKey);
    await fs.mkdir(path.join(scoped.fsPath, 'conversations'), { recursive: true });
    await fs.writeFile(path.join(scoped.fsPath, 'conversations', 'index.json'), '{}');
    await fs.writeFile(
      path.join(source.fsPath, '.limcode-workspace-runtimes', 'legacy-owner.json'),
      JSON.stringify({ kind: 'limcode.workspaceRuntimeLegacyOwner', schemaVersion: 1, scopeKey: scope.scopeKey, claimedAt: new Date().toISOString() })
    );

    const result = await copyStorageRootForMigration(source, target);
    assert.ok(result.copiedEntries.includes('.limcode-workspace-runtimes'));
    assert.equal(await exists(path.join(target.fsPath, '.limcode-workspace-runtimes', 'legacy-owner.json')), true);
    assert.equal(
      await exists(path.join(target.fsPath, '.limcode-workspace-runtimes', 'scopes', scope.scopeKey, 'conversations', 'index.json')),
      true
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('data-root migration refuses conflicting owner metadata instead of overwriting it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-owner-conflict-'));
  try {
    const source = MockUri.file(path.join(tempRoot, 'source'));
    const target = MockUri.file(path.join(tempRoot, 'target'));
    const sourceScope = folderScope('/migration/source-workspace');
    const targetScope = folderScope('/migration/target-workspace');
    const sourceOwner = { kind: 'limcode.workspaceRuntimeLegacyOwner', schemaVersion: 1, scopeKey: sourceScope.scopeKey, claimedAt: new Date().toISOString() };
    const targetOwner = { kind: 'limcode.workspaceRuntimeLegacyOwner', schemaVersion: 1, scopeKey: targetScope.scopeKey, claimedAt: new Date().toISOString() };
    await fs.mkdir(path.join(source.fsPath, '.limcode-workspace-runtimes'), { recursive: true });
    await fs.mkdir(path.join(target.fsPath, '.limcode-workspace-runtimes'), { recursive: true });
    await fs.writeFile(path.join(source.fsPath, '.limcode-workspace-runtimes', 'legacy-owner.json'), JSON.stringify(sourceOwner));
    await fs.writeFile(path.join(target.fsPath, '.limcode-workspace-runtimes', 'legacy-owner.json'), JSON.stringify(targetOwner));

    await assert.rejects(() => copyStorageRootForMigration(source, target), /目标数据目录已包含 LimCode 注册数据/);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(target.fsPath, '.limcode-workspace-runtimes', 'legacy-owner.json'), 'utf8')),
      targetOwner
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('restore vscode mock', () => {
  Module._load = originalLoad;
});
