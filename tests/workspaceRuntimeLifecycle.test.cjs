const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.split(path.sep).join('/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  static from(input) { return new MockUri(input.path || '/'); }
  static parse(value) { return new MockUri(value.replace(/^file:\/\//, '')); }
  toString() { return `file://${this.path}`; }
}

class MockRelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

const watchers = [];
const createDirectoryCalls = [];
let registeredProvider;
const vscodeMock = {
  Uri: MockUri,
  RelativePattern: MockRelativePattern,
  FileType: { File: 1, Directory: 2 },
  workspace: {
    workspaceFile: undefined,
    workspaceFolders: [],
    fs: {
      createDirectory: async (uri) => {
        createDirectoryCalls.push(uri.fsPath);
        await fs.mkdir(uri.fsPath, { recursive: true });
      },
      readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
        .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
      readFile: (uri) => fs.readFile(uri.fsPath),
      writeFile: async (uri, data) => {
        await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.writeFile(uri.fsPath, data);
      },
      stat: async (uri) => {
        const stat = await fs.stat(uri.fsPath);
        return { type: stat.isDirectory() ? 2 : 1, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
      },
      copy: (source, target, options) => fs.cp(source.fsPath, target.fsPath, { recursive: true, force: !!options?.overwrite }),
      delete: (uri, options) => fs.rm(uri.fsPath, { recursive: !!options?.recursive, force: false })
    },
    createFileSystemWatcher(pattern) {
      const watcher = {
        pattern,
        disposed: false,
        onDidCreate: () => ({ dispose() {} }),
        onDidChange: () => ({ dispose() {} }),
        onDidDelete: () => ({ dispose() {} }),
        dispose() { this.disposed = true; }
      };
      watchers.push(watcher);
      return watcher;
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} })
  },
  commands: { executeCommand: async () => undefined },
  window: {
    registerWebviewViewProvider(_id, provider) {
      registeredProvider = provider;
      return { dispose() {} };
    },
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  if (request === '../panels/MainPanel') {
    return {
      MainPanel: {
        onDidChangeConversationPanelState: () => ({ dispose() {} }),
        createOrShow() {},
        refreshConversationTitle() {}
      }
    };
  }
  if (request === '../webview/getWebviewHtml') {
    return {
      getWebviewHtml: () => '<html></html>',
      getWebviewStaticResourceRoots: () => []
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.on('exit', () => { Module._load = originalLoad; });

const { createVsCodeStorageCapability } = require('../dist/extension/backend/capabilities/vscodeStorage/index.js');
const { registerSidebarEntryView } = require('../dist/extension/vscode/views/SidebarEntryView.js');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function fileExists(filePath) {
  try { await fs.stat(filePath); return true; } catch { return false; }
}

function createContext(rootPath) {
  const values = new Map();
  return {
    globalStorageUri: MockUri.file(rootPath),
    storageUri: MockUri.file(path.join(rootPath, 'window-storage')),
    extensionUri: MockUri.file(path.join(rootPath, 'extension')),
    globalState: {
      get: (key) => values.get(key),
      update: async (key, value) => { values.set(key, value); }
    },
    subscriptions: []
  };
}

function registerSidebarHarness(context, storage, admissionGate) {
  let postCount = 0;
  const backendApp = {
    getConversationHistoryRootUri: () => storage.paths.conversationHistoryRootUri,
    isStorageReady: () => storage.isDataRootReady(),
    waitUntilStorageReady: async () => {
      await admissionGate.promise;
      await storage.ensureReady();
    },
    onDidChangeStorageRoot: (listener) => storage.onDidChangeStorageRoot(listener),
    onDidChangeConversationHistory: () => ({ dispose() {} })
  };
  registerSidebarEntryView(context, backendApp);
  const webview = {
    options: {},
    html: '',
    onDidReceiveMessage: () => ({ dispose() {} }),
    postMessage: async () => { postCount += 1; return true; }
  };
  registeredProvider.resolveWebviewView({
    webview,
    onDidDispose: () => ({ dispose() {} })
  });
  return { provider: registeredProvider, get postCount() { return postCount; } };
}

function resetHarnessState() {
  watchers.length = 0;
  createDirectoryCalls.length = 0;
  registeredProvider = undefined;
}

test('Sidebar waits for admission before any provisional write and then binds the partitioned workspace root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-runtime-legacy-lifecycle-'));
  let context;
  try {
    resetHarnessState();
    await fs.mkdir(path.join(tempRoot, 'agents'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'agents', 'legacy.json'), '{}');
    vscodeMock.workspace.workspaceFolders = [{ uri: MockUri.file(path.join(tempRoot, 'workspace')) }];

    context = createContext(tempRoot);
    const storage = createVsCodeStorageCapability(context);
    const gate = deferred();
    registerSidebarHarness(context, storage, gate);

    const provisionalRoot = storage.paths.conversationHistoryRootUri.fsPath;
    assert.equal(storage.isDataRootReady(), false);
    assert.match(provisionalRoot, /\.limcode-workspace-runtimes[\\/]scopes[\\/]/);
    await delay(30);
    assert.equal(watchers.length, 0);
    assert.equal(createDirectoryCalls.includes(provisionalRoot), false);
    assert.equal(await fileExists(provisionalRoot), false, 'Sidebar must not create provisional conversation-history before admission');

    gate.resolve();
    await waitFor(() => storage.isDataRootReady() && watchers.length === 1, 'Sidebar watcher did not bind after storage admission');

    const resolvedRoot = storage.paths.conversationHistoryRootUri.fsPath;
    assert.equal(resolvedRoot, provisionalRoot, 'legacy partition publishes into the frozen workspace scope');
    assert.equal(watchers[0].pattern.base.fsPath, resolvedRoot);
    assert.ok(createDirectoryCalls.includes(resolvedRoot));
  } finally {
    context?.subscriptions.forEach((item) => item.dispose());
    vscodeMock.workspace.workspaceFolders = [];
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('a second-window Sidebar resolving behind migration fence performs no old-root write', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-runtime-sidebar-fence-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const copyStarted = deferred();
  const releaseCopy = deferred();
  const originalCopy = vscodeMock.workspace.fs.copy;
  let contextA;
  let contextB;
  try {
    resetHarnessState();
    await fs.mkdir(path.join(oldRoot, 'agents'), { recursive: true });
    await fs.writeFile(path.join(oldRoot, 'agents', 'legacy.json'), '{}');
    vscodeMock.workspace.workspaceFolders = [{ uri: MockUri.file(path.join(tempRoot, 'workspace')) }];

    contextA = createContext(oldRoot);
    const storageA = createVsCodeStorageCapability(contextA);
    const revision = (await storageA.loadGlobalSettings('common')).revision;
    let copyBlocked = false;
    vscodeMock.workspace.fs.copy = async (source, target, options) => {
      if (!copyBlocked) {
        copyBlocked = true;
        copyStarted.resolve();
        await releaseCopy.promise;
      }
      return originalCopy(source, target, options);
    };
    const migration = storageA.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' }, revision);
    await copyStarted.promise;

    contextB = createContext(oldRoot);
    const storageB = createVsCodeStorageCapability(contextB);
    const immediateAdmission = deferred();
    immediateAdmission.resolve();
    registerSidebarHarness(contextB, storageB, immediateAdmission);
    const provisionalRoot = storageB.paths.conversationHistoryRootUri.fsPath;
    assert.equal(path.relative(oldRoot, provisionalRoot).startsWith('..'), false);

    await delay(50);
    assert.equal(storageB.isDataRootReady(), false, 'second window admission must still be waiting on migration fence');
    assert.equal(watchers.length, 0);
    assert.equal(createDirectoryCalls.includes(provisionalRoot), false);
    assert.equal(await fileExists(provisionalRoot), false, 'Sidebar must not materialize the old provisional root while migration owns the fence');

    releaseCopy.resolve();
    await migration;
    await waitFor(() => storageB.isDataRootReady() && watchers.length === 1, 'second-window Sidebar did not bind after migration');
    assert.equal(storageB.paths.globalStoragePath, path.resolve(newRoot));
    assert.equal(watchers[0].pattern.base.fsPath, storageB.paths.conversationHistoryRootUri.fsPath);
    assert.match(watchers[0].pattern.base.fsPath, /\.limcode-workspace-runtimes[\\/]scopes[\\/]/);
  } finally {
    vscodeMock.workspace.fs.copy = originalCopy;
    releaseCopy.resolve();
    contextA?.subscriptions.forEach((item) => item.dispose());
    contextB?.subscriptions.forEach((item) => item.dispose());
    vscodeMock.workspace.workspaceFolders = [];
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('fresh scoped root binds after ready without a root-change event and provider dispose releases watcher/timer', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-runtime-fresh-lifecycle-'));
  let context;
  try {
    resetHarnessState();
    vscodeMock.workspace.workspaceFolders = [{ uri: MockUri.file(path.join(tempRoot, 'workspace')) }];

    context = createContext(tempRoot);
    const storage = createVsCodeStorageCapability(context);
    const gate = deferred();
    const sidebar = registerSidebarHarness(context, storage, gate);
    const scopedRoot = storage.paths.conversationHistoryRootUri.fsPath;
    assert.equal(context.subscriptions.includes(sidebar.provider), true, 'provider must participate in extension disposal');

    await delay(30);
    assert.equal(watchers.length, 0);
    assert.equal(createDirectoryCalls.includes(scopedRoot), false);
    assert.equal(await fileExists(scopedRoot), false);

    gate.resolve();
    await waitFor(() => storage.isDataRootReady() && watchers.length === 1, 'fresh scoped watcher did not bind after ready');
    assert.equal(storage.paths.conversationHistoryRootUri.fsPath, scopedRoot, 'fresh scope keeps the same resolved identity');
    assert.equal(watchers[0].pattern.base.fsPath, scopedRoot);
    assert.ok(createDirectoryCalls.includes(scopedRoot));

    sidebar.provider.refreshConversationHistory();
    assert.notEqual(sidebar.provider.historyRefreshTimer, undefined);
    const postsBeforeDispose = sidebar.postCount;
    context.subscriptions.forEach((item) => item.dispose());
    context = undefined;
    assert.equal(watchers[0].disposed, true);
    assert.equal(sidebar.provider.historyWatcher, undefined);
    assert.equal(sidebar.provider.historyRefreshTimer, undefined);
    await delay(220);
    assert.equal(sidebar.postCount, postsBeforeDispose, 'disposed refresh timer must not post a late Sidebar update');
  } finally {
    context?.subscriptions.forEach((item) => item.dispose());
    vscodeMock.workspace.workspaceFolders = [];
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
