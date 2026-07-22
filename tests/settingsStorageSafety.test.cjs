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

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static joinPath(base, ...segments) {
    return new MockUri(path.join(base.fsPath, ...segments));
  }

  static from(input) {
    return new MockUri(input.path || '/');
  }

  toString() {
    return `file://${this.fsPath.replace(/\\/g, '/')}`;
  }
}

function installVscodeMock() {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      workspaceFolders: [],
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        delete: (uri) => fs.rm(uri.fsPath, { recursive: true, force: false }),
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

function createContext(rootPath) {
  const values = new Map();
  return {
    globalStorageUri: MockUri.file(rootPath),
    globalState: {
      get: (key) => values.get(key),
      update: async (key, value) => { values.set(key, value); }
    },
    subscriptions: []
  };
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTempRoot(target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code)) throw error;
      await delay(25 * attempt);
    }
  }
}

const restore = installVscodeMock();
process.on('exit', restore);

const { BridgeMessageType } = require('../dist/extension/shared/protocol.js');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { ConversationSettingsBridge } = require('../dist/extension/backend/application/ConversationSettingsBridge.js');
const { loadGlobalSettingsFile } = require('../dist/extension/backend/capabilities/vscodeStorage/globalSettings.js');
const { createVsCodeStorageCapability } = require('../dist/extension/backend/capabilities/vscodeStorage/index.js');

test('global settings missing initializes defaults with envelope', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-global-missing-'));
  try {
    const settingsRoot = MockUri.file(path.join(tempRoot, 'settings'));
    const loaded = await loadGlobalSettingsFile(settingsRoot, 'attachments');
    assert.equal(loaded.section, 'attachments');
    assert.deepEqual(loaded.settings, { maxStoredInlineFileMb: 20 });

    const file = JSON.parse(await fs.readFile(path.join(settingsRoot.fsPath, 'attachments.json'), 'utf8'));
    assert.equal(file.schemaVersion, 1);
    assert.equal(typeof file.savedAt, 'string');
    assert.deepEqual(file.settings, { maxStoredInlineFileMb: 20 });
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('global settings invalid JSON and I/O errors are not overwritten', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-global-invalid-'));
  try {
    const settingsRootPath = path.join(tempRoot, 'settings');
    await fs.mkdir(settingsRootPath, { recursive: true });
    const invalidPath = path.join(settingsRootPath, 'attachments.json');
    await fs.writeFile(invalidPath, '{not-json', 'utf8');
    await assert.rejects(() => loadGlobalSettingsFile(MockUri.file(settingsRootPath), 'attachments'), /Failed to read global settings attachments|invalid/i);
    assert.equal(await fs.readFile(invalidPath, 'utf8'), '{not-json');

    const ioRootPath = path.join(tempRoot, 'settings-io');
    await fs.mkdir(path.join(ioRootPath, 'run-history.json'), { recursive: true });
    await assert.rejects(() => loadGlobalSettingsFile(MockUri.file(ioRootPath), 'runHistory'), /Failed to read global settings runHistory|I\/O|illegal operation|EISDIR|directory/i);
    const stat = await fs.stat(path.join(ioRootPath, 'run-history.json'));
    assert.equal(stat.isDirectory(), true);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('conversation llm missing freezes current global default', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-conv-missing-'));
  let context;
  try {
    context = createContext(tempRoot);
    const storage = createVsCodeStorageCapability(context);
    const loaded = await storage.loadConversationSettings('conv-a', 'llm');
    assert.equal(loaded.conversationId, 'conv-a');
    assert.equal(loaded.section, 'llm');
    assert.equal(typeof loaded.settings.activeProviderConfigId, 'string');
    assert.ok(loaded.settings.activeProviderConfigId.length > 0);

    const file = JSON.parse(await fs.readFile(path.join(tempRoot, 'settings', 'conversation-conv-a-llm.json'), 'utf8'));
    assert.deepEqual(file, loaded.settings);
  } finally {
    context?.subscriptions.forEach((item) => item.dispose());
    await removeTempRoot(tempRoot);
  }
});

test('conversation settings invalid structures reject without overwrite', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-conv-invalid-'));
  let context;
  try {
    const settingsRoot = path.join(tempRoot, 'settings');
    await fs.mkdir(settingsRoot, { recursive: true });
    const llmPath = path.join(settingsRoot, 'conversation-conv-b-llm.json');
    await fs.writeFile(llmPath, JSON.stringify({ conversationId: 'conv-b', modelOverrides: {} }), 'utf8');
    context = createContext(tempRoot);
    const storage = createVsCodeStorageCapability(context);
    await assert.rejects(() => storage.loadConversationSettings('conv-b', 'llm'), /Invalid conversation LLM settings file/);
    assert.deepEqual(JSON.parse(await fs.readFile(llmPath, 'utf8')), { conversationId: 'conv-b', modelOverrides: {} });

    const commonPath = path.join(settingsRoot, 'conversation-conv-b-common.json');
    await fs.writeFile(commonPath, JSON.stringify({ conversationId: 'other', name: 'bad' }), 'utf8');
    await assert.rejects(() => storage.loadConversationSettings('conv-b', 'common'), /Invalid conversation common settings file/);
    assert.deepEqual(JSON.parse(await fs.readFile(commonPath, 'utf8')), { conversationId: 'other', name: 'bad' });
  } finally {
    context?.subscriptions.forEach((item) => item.dispose());
    await removeTempRoot(tempRoot);
  }
});

test('ConversationSettingsBridge posts settings error envelopes for get and update', async () => {
  const posted = [];
  const broadcasts = [];
  const bridge = new ConversationSettingsBridge({
    world: new MapWorld(),
    storage: {
      loadConversationSettings: async () => { throw new Error('boom-load'); },
      saveConversationSettings: async () => { throw new Error('boom-save'); }
    },
    webview: {
      subscribe() {},
      post: (clientId, message) => posted.push({ clientId, message }),
      broadcast: (message) => broadcasts.push(message),
      broadcastToStream: (streamId, message) => broadcasts.push({ streamId, message })
    },
    requestSnapshot() {}
  });

  await bridge.postSnapshot('client-a', 'conv-c', 'llm', 'req-get');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].clientId, 'client-a');
  assert.equal(posted[0].message.type, BridgeMessageType.Error);
  assert.equal(posted[0].message.channel, 'settings');
  assert.deepEqual(posted[0].message.scope, { kind: 'settings', level: 'conversation', id: 'conv-c' });
  assert.equal(posted[0].message.correlationId, 'req-get');
  assert.equal(posted[0].message.payload.requestType, BridgeMessageType.ConversationSettingsGet);
  assert.match(posted[0].message.payload.message, /boom-load/);

  await bridge.update({ section: 'common', settings: { conversationId: 'conv-c', name: 'Name' } }, 'req-update', 'client-b');
  assert.equal(posted.length, 2);
  assert.equal(posted[1].clientId, 'client-b');
  assert.equal(posted[1].message.type, BridgeMessageType.Error);
  assert.equal(posted[1].message.channel, 'settings');
  assert.deepEqual(posted[1].message.scope, { kind: 'settings', level: 'conversation', id: 'conv-c' });
  assert.equal(posted[1].message.correlationId, 'req-update');
  assert.equal(posted[1].message.payload.requestType, BridgeMessageType.ConversationSettingsUpdate);
  assert.match(posted[1].message.payload.message, /boom-save/);
});
