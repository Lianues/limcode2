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
  }

  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
}

function installVscodeMock() {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        delete: (uri, options = {}) => fs.rm(uri.fsPath, { recursive: !!options.recursive, force: false }),
        readFile: (uri) => fs.readFile(uri.fsPath),
        writeFile: async (uri, data) => {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, data);
        }
      }
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
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function skeletonState(createEmptyClientState, suffix) {
  const state = createEmptyClientState();
  state.conversations.push({ id: `conversation-${suffix}`, title: suffix, visibility: 'visible' });
  state.agents.push({ id: `agent-${suffix}`, name: suffix, kind: 'main', createdAt: 1, updatedAt: 1 });
  state.agentConversationLinks.push({
    id: `link-${suffix}`,
    agentId: `agent-${suffix}`,
    conversationId: `conversation-${suffix}`,
    role: 'default'
  });
  return state;
}

const restore = installVscodeMock();
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const skeletonTransaction = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonTransaction.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

test('skeleton reader waits for a multi-store mutation and observes one committed snapshot', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-skeleton-transaction-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const gate = deferred();
  const writing = deferred();
  try {
    await clientStateStore.saveClientStateSkeletonToStores(paths, skeletonState(createEmptyClientState, 'old'));

    let blocked = false;
    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterManifestWrite = async (manifest) => {
      if (!blocked && manifest.state === 'writing') {
        blocked = true;
        writing.resolve();
        await gate.promise;
      }
    };

    const saving = clientStateStore.saveClientStateSkeletonToStores(paths, skeletonState(createEmptyClientState, 'new'));
    await writing.promise;

    let readerResolved = false;
    const reading = clientStateStore.loadClientStateSkeletonFromStores(paths, { profile: 'full' }).then((value) => {
      readerResolved = true;
      return value;
    });
    await delay(40);
    assert.equal(readerResolved, false, 'reader must wait for the skeleton transaction lock');

    gate.resolve();
    await saving;
    const loaded = await reading;
    assert.deepEqual(loaded.conversations.map((record) => record.id), ['conversation-new']);
    assert.deepEqual(loaded.agents.map((record) => record.id), ['agent-new']);
    assert.deepEqual(loaded.agentConversationLinks.map((record) => record.id), ['link-new']);
  } finally {
    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterManifestWrite = undefined;
    gate.resolve();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('failed skeleton publication leaves writing marker and blocks mixed snapshot reads until repaired', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-skeleton-failure-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    await clientStateStore.saveClientStateSkeletonToStores(paths, skeletonState(createEmptyClientState, 'old'));
    clientStateStore.__clientStateSkeletonStoreTestHooks.afterStoresSaved = async () => {
      throw new Error('simulated skeleton publication failure');
    };

    await assert.rejects(
      () => clientStateStore.saveClientStateSkeletonToStores(paths, skeletonState(createEmptyClientState, 'partial')),
      /simulated skeleton publication failure/
    );
    await assert.rejects(
      () => clientStateStore.loadClientStateSkeletonFromStores(paths, { profile: 'full' }),
      /not committed/i
    );

    clientStateStore.__clientStateSkeletonStoreTestHooks.afterStoresSaved = undefined;
    await clientStateStore.saveClientStateSkeletonToStores(paths, skeletonState(createEmptyClientState, 'repaired'));
    const repaired = await clientStateStore.loadClientStateSkeletonFromStores(paths, { profile: 'full' });
    assert.deepEqual(repaired.conversations.map((record) => record.id), ['conversation-repaired']);
  } finally {
    clientStateStore.__clientStateSkeletonStoreTestHooks.afterStoresSaved = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('startup/deferred hydration can pin one committed skeleton transaction', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-skeleton-pinned-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    await clientStateStore.saveClientStateSkeletonToStores(paths, skeletonState(createEmptyClientState, 'first'));
    const startup = await clientStateStore.loadClientStateSkeletonSnapshotFromStores(paths, { profile: 'startup' });
    await clientStateStore.saveClientStateSkeletonToStores(paths, skeletonState(createEmptyClientState, 'second'));
    await assert.rejects(
      () => clientStateStore.loadClientStateSkeletonSnapshotFromStores(paths, { profile: 'deferred' }, startup.transactionId),
      /snapshot changed during staged hydration/i
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('manifest missing with skeleton traces is rejected rather than treated as an empty store', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-skeleton-trace-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    await fs.mkdir(path.dirname(paths.conversationsIndexUri.fsPath), { recursive: true });
    await fs.writeFile(paths.conversationsIndexUri.fsPath, '{}\n');
    await assert.rejects(
      () => clientStateStore.loadClientStateSkeletonFromStores(paths, { profile: 'full' }),
      /manifest is missing.*traces exist/i
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('收尾恢复 vscode mock', () => {
  restore();
});
