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
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  static from(input) { return new MockUri(input.path || '/'); }
  static parse(value) { return new MockUri(value.replace(/^file:\/\//, '')); }
  toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function installVscodeMock(hooks = {}) {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      workspaceFolders: [],
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        stat: async (uri) => {
          const stat = await fs.stat(uri.fsPath);
          return { type: stat.isDirectory() ? 2 : 1 };
        },
        copy: async (source, target, options) => {
          await hooks.beforeCopy?.(source.fsPath, target.fsPath);
          await fs.cp(source.fsPath, target.fsPath, { recursive: true, force: !!options?.overwrite });
          await hooks.afterCopy?.(source.fsPath, target.fsPath);
        },
        delete: async (uri, options) => {
          await hooks.beforeDelete?.(uri.fsPath);
          await fs.rm(uri.fsPath, { recursive: !!options?.recursive, force: false });
          await hooks.afterDelete?.(uri.fsPath);
        },
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

function createContext(rootPath, options = {}) {
  const values = options.values ?? new Map();
  return {
    globalStorageUri: MockUri.file(rootPath),
    globalState: {
      get: (key) => values.get(key),
      update: async (key, value) => {
        await options.beforeUpdate?.(key, value);
        if (options.failUpdate) throw new Error('global-status-failed');
        values.set(key, value);
        await options.afterUpdate?.(key, value);
      }
    },
    subscriptions: []
  };
}

function disposeContext(context) {
  context?.subscriptions?.forEach((item) => item.dispose());
}

async function removeTempRoot(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function seedRegisteredRoot(root, name = 'agent-a') {
  await fs.mkdir(path.join(root, 'agents'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents', `${name}.json`), JSON.stringify({ id: name }), 'utf8');
}

function patchWriteFileForBlock(match, order) {
  const original = fs.writeFile;
  const gate = deferred();
  let started = false;
  fs.writeFile = async function patchedWriteFile(file, data, options) {
    const filePath = typeof file === 'string' ? file : file && file.toString ? file.toString() : '';
    if (!started && match(filePath)) {
      started = true;
      order?.push('shared-write-start');
      await gate.promise;
      order?.push('shared-write-release');
    }
    return original.call(this, file, data, options);
  };
  return {
    get started() { return started; },
    release: () => gate.resolve(),
    restore: () => { fs.writeFile = original; }
  };
}

let restoreVscode = installVscodeMock();
process.on('exit', () => restoreVscode());

function reloadStorageModule(hooks) {
  restoreVscode();
  restoreVscode = installVscodeMock(hooks);
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}dist${path.sep}extension${path.sep}backend${path.sep}capabilities${path.sep}vscodeStorage${path.sep}`)) {
      delete require.cache[key];
    }
  }
  const modulePath = require.resolve('../dist/extension/backend/capabilities/vscodeStorage/index.js');
  return require(modulePath).createVsCodeStorageCapability;
}

test('started shared write finishes before data-root migration copies', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-migration-shared-first-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const order = [];
  const createVsCodeStorageCapability = reloadStorageModule({
    beforeCopy: async () => { order.push('copy'); }
  });
  const blocker = patchWriteFileForBlock((filePath) => filePath.includes('attachments.json'), order);
  let context;
  try {
    await seedRegisteredRoot(oldRoot);
    context = createContext(oldRoot);
    const storage = createVsCodeStorageCapability(context);
    const shared = storage.saveGlobalSettings('attachments', { maxStoredInlineFileMb: 7 });
    while (!blocker.started) await delay(5);

    const migration = storage.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' });
    await delay(30);
    assert.equal(order.includes('copy'), false, 'exclusive migration must wait for active shared write');

    blocker.release();
    await Promise.all([shared, migration]);
    const releaseIndex = order.indexOf('shared-write-release');
    const firstCopyIndex = order.indexOf('copy');
    assert.ok(firstCopyIndex > releaseIndex, `copy must start after shared write release: ${order.join(' -> ')}`);
  } finally {
    blocker.restore();
    disposeContext(context);
    await removeTempRoot(tempRoot);
  }
});

test('new shared writes queue while migration is active and paths provider can recover', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-migration-active-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const copyGate = deferred();
  const copyStarted = deferred();
  const order = [];
  const createVsCodeStorageCapability = reloadStorageModule({
    beforeCopy: async () => {
      order.push('copy-start');
      copyStarted.resolve();
      await copyGate.promise;
      order.push('copy-release');
    }
  });
  let context;
  try {
    await seedRegisteredRoot(oldRoot);
    context = createContext(oldRoot);
    const storage = createVsCodeStorageCapability(context);
    const pathsProvider = () => storage.isDataRootMutationActive?.() ? undefined : storage.paths;
    const migration = storage.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' });
    await copyStarted.promise;
    assert.equal(storage.isDataRootMutationActive(), true);
    assert.equal(pathsProvider(), undefined, 'command paths provider should return undefined during exclusive migration');

    let sharedResolved = false;
    const shared = storage.saveGlobalSettings('attachments', { maxStoredInlineFileMb: 8 }).then(() => { sharedResolved = true; order.push('shared-after-migration'); });
    await delay(30);
    assert.equal(sharedResolved, false, 'new shared write must queue while exclusive migration is active');

    copyGate.resolve();
    await Promise.all([migration, shared]);
    assert.equal(storage.isDataRootMutationActive(), false);
    assert.equal(pathsProvider().globalStoragePath, path.resolve(newRoot));
    assert.deepEqual(order, ['copy-start', 'copy-release', 'shared-after-migration']);
    assert.ok(await fileExists(path.join(newRoot, 'settings', 'attachments.json')));
  } finally {
    disposeContext(context);
    await removeTempRoot(tempRoot);
  }
});

test('globalStatus failure keeps old root intact and active', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-migration-status-fail-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const createVsCodeStorageCapability = reloadStorageModule();
  let context;
  try {
    await seedRegisteredRoot(oldRoot);
    context = createContext(oldRoot, { failUpdate: true });
    const storage = createVsCodeStorageCapability(context);
    await assert.rejects(() => storage.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' }), /global-status-failed/);
    assert.ok(await fileExists(path.join(oldRoot, 'agents', 'agent-a.json')), 'old root must not be cleaned when status update fails');
    assert.ok(await fileExists(path.join(newRoot, 'agents', 'agent-a.json')), 'copy may exist in target, but active root remains old');
    assert.equal(storage.paths.globalStoragePath, path.resolve(oldRoot));
  } finally {
    disposeContext(context);
    await removeTempRoot(tempRoot);
  }
});

test('attachment operations queue while migration is active', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-migration-attachment-gate-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const sourceFile = path.join(tempRoot, 'source.txt');
  const copyGate = deferred();
  const copyStarted = deferred();
  const createVsCodeStorageCapability = reloadStorageModule({
    beforeCopy: async () => {
      copyStarted.resolve();
      await copyGate.promise;
    }
  });
  let context;
  try {
    await seedRegisteredRoot(oldRoot);
    await fs.writeFile(sourceFile, 'attachment-body', 'utf8');
    context = createContext(oldRoot);
    const storage = createVsCodeStorageCapability(context);
    const migration = storage.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' });
    await copyStarted.promise;

    let resolved = false;
    const attachment = storage.resolveAttachmentForClient({ sourcePath: sourceFile, mimeType: 'text/plain', name: 'source.txt' })
      .then((result) => { resolved = true; return result; });
    await delay(30);
    assert.equal(resolved, false, 'attachment read must queue behind active data-root migration');

    copyGate.resolve();
    const result = await attachment;
    await migration;
    assert.equal(result.status, 'available');
    assert.equal(Buffer.from(result.part.inlineData.data, 'base64').toString('utf8'), 'attachment-body');
  } finally {
    disposeContext(context);
    await removeTempRoot(tempRoot);
  }
});

test('migration refuses when another live instance still uses source root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-migration-live-lease-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const sharedValues = new Map();
  const createVsCodeStorageCapability = reloadStorageModule();
  let contextA;
  let contextB;
  try {
    await seedRegisteredRoot(oldRoot);
    contextA = createContext(oldRoot, { values: sharedValues });
    contextB = createContext(oldRoot, { values: sharedValues });
    const storageA = createVsCodeStorageCapability(contextA);
    const storageB = createVsCodeStorageCapability(contextB);
    await storageB.ensureReady();

    await assert.rejects(
      () => storageA.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' }),
      /其它 LimCode\/VS Code 窗口仍在使用源数据目录/
    );
    assert.equal(storageA.paths.globalStoragePath, path.resolve(oldRoot));
  } finally {
    disposeContext(contextA);
    disposeContext(contextB);
    await removeTempRoot(tempRoot);
  }
});

test('simultaneous migration requests across instances are serialized by stable lock', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-migration-serial-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const sharedValues = new Map();
  const copyGate = deferred();
  const copyStarted = deferred();
  const order = [];
  const createVsCodeStorageCapability = reloadStorageModule({
    beforeCopy: async () => {
      order.push('copy-start');
      copyStarted.resolve();
      await copyGate.promise;
      order.push('copy-release');
    }
  });
  let contextA;
  let contextB;
  try {
    await seedRegisteredRoot(oldRoot);
    contextB = createContext(oldRoot, { values: sharedValues });
    const storageB = createVsCodeStorageCapability(contextB);
    const first = storageB.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' });
    await copyStarted.promise;

    contextA = createContext(oldRoot, { values: sharedValues });
    const storageA = createVsCodeStorageCapability(contextA);
    const second = storageA.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: '' }).then(() => order.push('second-done'));
    await delay(30);
    assert.deepEqual(order, ['copy-start']);

    copyGate.resolve();
    await Promise.all([first, second]);
    assert.equal(storageA.paths.globalStoragePath, path.resolve(newRoot));
    assert.equal(storageB.paths.globalStoragePath, path.resolve(newRoot));
    assert.deepEqual(order, ['copy-start', 'copy-release', 'second-done']);
  } finally {
    disposeContext(contextA);
    disposeContext(contextB);
    await removeTempRoot(tempRoot);
  }
});

test('successful migration switches active root before best-effort cleanup', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-migration-success-'));
  const oldRoot = path.join(tempRoot, 'old');
  const newRoot = path.join(tempRoot, 'new');
  const order = [];
  const createVsCodeStorageCapability = reloadStorageModule({
    beforeCopy: async () => { order.push('copy'); },
    beforeDelete: async () => { order.push('cleanup'); }
  });
  let context;
  try {
    await seedRegisteredRoot(oldRoot);
    context = createContext(oldRoot, { beforeUpdate: async () => { order.push('status'); } });
    const storage = createVsCodeStorageCapability(context);
    await storage.saveGlobalSettings('common', { dataFilePath: newRoot, proxy: 'http://proxy.local' });
    assert.equal(storage.paths.globalStoragePath, path.resolve(newRoot));
    assert.ok(await fileExists(path.join(newRoot, 'agents', 'agent-a.json')));
    assert.equal(await fileExists(path.join(oldRoot, 'agents', 'agent-a.json')), false);
    assert.ok(order.indexOf('copy') >= 0 && order.indexOf('status') > order.indexOf('copy'));
    assert.ok(order.indexOf('cleanup') > order.indexOf('status'));
  } finally {
    disposeContext(context);
    await removeTempRoot(tempRoot);
  }
});

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
