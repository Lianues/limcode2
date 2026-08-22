const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

class MockUri {
  constructor(fsPath, scheme = 'file') {
    this.scheme = scheme;
    this.fsPath = scheme === 'file' ? path.resolve(fsPath) : fsPath;
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments), base.scheme); }
  toString() {
    if (this.scheme !== 'file') return `${this.scheme}:${this.path}`;
    const normalized = this.path.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
    return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
  }
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
        return { type: stat.isDirectory() ? 2 : 1, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
      },
      copy: (source, target, options) => fs.cp(source.fsPath, target.fsPath, {
        recursive: true,
        force: !!options?.overwrite,
        errorOnExist: !options?.overwrite
      }),
      rename: async (source, target, options) => {
        if (options?.overwrite) await fs.rm(target.fsPath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
        await fs.rename(source.fsPath, target.fsPath);
      },
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
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { createClientStateSkeletonPatch } = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonPatch.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const skeletonTransaction = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonTransaction.js');
const {
  mergeSharedConfigurationAndWorkspaceRuntime,
  sharedConfigurationState,
  workspaceRuntimeState
} = require('../dist/extension/backend/application/sharedConfigurationState.js');

function folderScope(...folders) {
  return createWorkspaceScopeIdentity({ workspaceFolderUris: folders.map(MockUri.file) });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function saveSkeleton(paths, state) {
  await clientStateStore.saveClientStateSkeletonToStores(
    paths,
    createClientStateSkeletonPatch(createEmptyClientState(), state)
  );
}

async function loadSkeleton(paths) {
  const pin = await skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'workspace-runtime-test');
  if (!pin) return createEmptyClientState();
  try {
    return await clientStateStore.loadClientStateSkeletonSnapshotFromStores(paths, pin) ?? createEmptyClientState();
  } finally {
    await skeletonTransaction.releaseClientStateSkeletonSnapshot(paths, pin);
  }
}

test('workspace scope prefers saved workspace file and folder identity is order-independent', () => {
  const folderA = MockUri.file('/workspace/a');
  const folderB = MockUri.file('/workspace/b');
  const workspaceFile = MockUri.file('/workspaces/project.code-workspace');
  const byFileA = createWorkspaceScopeIdentity({ workspaceFileUri: workspaceFile, workspaceFolderUris: [folderA] });
  const byFileB = createWorkspaceScopeIdentity({ workspaceFileUri: workspaceFile, workspaceFolderUris: [folderB] });
  assert.equal(byFileA.scopeKey, byFileB.scopeKey);
  assert.equal(byFileA.source, 'workspaceFile');

  const ordered = createWorkspaceScopeIdentity({ workspaceFolderUris: [folderA, folderB, folderA] });
  const reversed = createWorkspaceScopeIdentity({ workspaceFolderUris: [folderB, folderA] });
  assert.equal(ordered.scopeKey, reversed.scopeKey);
  assert.equal(ordered.scopeKey.length, 64);
  assert.doesNotMatch(ordered.scopeKey, /workspace/i);
});

test('workspace runtime root resolves directly from the frozen scope identity', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-direct-scope-'));
  try {
    const root = MockUri.file(rootPath);
    const scope = folderScope('/workspace/a');
    const expected = workspaceScopedRuntimeRoot(root, scope.scopeKey);
    const actual = await resolveWorkspaceRuntimeRoot(root, scope);
    assert.equal(actual.fsPath, expected.fsPath);
    assert.equal(await exists(path.join(rootPath, '.limcode-workspace-runtimes')), true);
    assert.equal(await exists(expected.fsPath), false, 'scope data root remains lazy until a store writes data');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('different workspaces isolate runtime indexes while sharing global configuration settings', () => {
  const configurationRoot = MockUri.file('/limcode-data');
  const pathsA = createVscodeStoragePaths(workspaceScopedRuntimeRoot(configurationRoot, folderScope('/workspace/a').scopeKey), configurationRoot);
  const pathsB = createVscodeStoragePaths(workspaceScopedRuntimeRoot(configurationRoot, folderScope('/workspace/b').scopeKey), configurationRoot);
  assert.notEqual(pathsA.conversationsIndexPath, pathsB.conversationsIndexPath);
  assert.notEqual(pathsA.runHistoryIndexPath, pathsB.runHistoryIndexPath);
  assert.notEqual(pathsA.conversationSettingsRootUri.fsPath, pathsB.conversationSettingsRootUri.fsPath);
  assert.equal(pathsA.settingsRootPath, pathsB.settingsRootPath);
  assert.equal(pathsA.sharedConfigurationRootPath, pathsB.sharedConfigurationRootPath);
  assert.equal(pathsA.globalStoragePath, pathsB.globalStoragePath);
});

test('agents and scoped configuration are shared while conversation indexes remain workspace-local', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shared-configuration-'));
  try {
    const configurationRoot = MockUri.file(rootPath);
    const pathsA = createVscodeStoragePaths(
      workspaceScopedRuntimeRoot(configurationRoot, folderScope('/workspace/a').scopeKey),
      configurationRoot
    );
    const pathsB = createVscodeStoragePaths(
      workspaceScopedRuntimeRoot(configurationRoot, folderScope('/workspace/b').scopeKey),
      configurationRoot
    );
    const source = createEmptyClientState();
    source.agents.push({ id: 'agent-shared', name: 'Shared Agent', kind: 'worker', source: 'user', status: 'idle' });
    source.workflows.push({ id: 'workflow-shared', name: 'Shared Workflow', source: 'user', createdAt: 1, updatedAt: 1 });
    source.conversations.push({ id: 'conversation-a', title: 'Workspace A' });
    source.toolPolicies.push({ id: 'tool-policy-conversation-a', name: 'Conversation A policy', allowedTools: ['read'] });
    source.toolPolicyScopeLinks.push({
      id: 'tool-policy-link-conversation-a',
      scopeKind: 'conversation',
      scopeId: 'conversation-a',
      toolPolicyId: 'tool-policy-conversation-a',
      role: 'active',
      createdAt: 1,
      updatedAt: 1
    });

    await saveSkeleton(pathsA, workspaceRuntimeState(source));
    const sharedPaths = createVscodeStoragePaths(pathsA.sharedConfigurationRootUri, configurationRoot);
    await saveSkeleton(sharedPaths, sharedConfigurationState(source));

    const restoredA = mergeSharedConfigurationAndWorkspaceRuntime(await loadSkeleton(sharedPaths), await loadSkeleton(pathsA));
    const restoredB = mergeSharedConfigurationAndWorkspaceRuntime(
      await loadSkeleton(createVscodeStoragePaths(pathsB.sharedConfigurationRootUri, configurationRoot)),
      await loadSkeleton(pathsB)
    );

    assert.deepEqual(restoredA.conversations.map((conversation) => conversation.id), ['conversation-a']);
    assert.deepEqual(restoredB.conversations, []);
    assert.deepEqual(restoredB.agents.map((agent) => agent.id), ['agent-shared']);
    assert.deepEqual(restoredB.workflows.map((workflow) => workflow.id), ['workflow-shared']);
    assert.deepEqual(restoredB.toolPolicies.map((policy) => policy.id), ['tool-policy-conversation-a']);
    assert.deepEqual(restoredB.toolPolicyScopeLinks.map((link) => link.scopeId), ['conversation-a']);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('data-root migration copies scoped runtime trees and shared configuration', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-migration-'));
  try {
    const source = MockUri.file(path.join(tempRoot, 'source'));
    const target = MockUri.file(path.join(tempRoot, 'target'));
    await fs.mkdir(path.join(source.fsPath, '.limcode-workspace-runtimes', 'scopes', 'scope-a'), { recursive: true });
    await fs.writeFile(path.join(source.fsPath, '.limcode-workspace-runtimes', 'scopes', 'scope-a', 'sentinel.json'), '{}');
    await fs.mkdir(path.join(source.fsPath, 'shared-configuration'), { recursive: true });
    await fs.writeFile(path.join(source.fsPath, 'shared-configuration', 'sentinel.json'), '{}');

    const result = await copyStorageRootForMigration(source, target);
    assert.ok(result.copiedEntries.includes('.limcode-workspace-runtimes'));
    assert.ok(result.copiedEntries.includes('shared-configuration'));
    assert.equal(await exists(path.join(target.fsPath, '.limcode-workspace-runtimes', 'scopes', 'scope-a', 'sentinel.json')), true);
    assert.equal(await exists(path.join(target.fsPath, 'shared-configuration', 'sentinel.json')), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('restore vscode mock', () => { Module._load = originalLoad; });
