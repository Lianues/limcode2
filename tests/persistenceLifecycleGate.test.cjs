const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath || '.');
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  static from(input) { return new MockUri(input.path || '/'); }
  static parse(value) { return new MockUri(value.replace(/^file:\/\//, '')); }
  toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
}

function installVscodeMock() {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      workspaceFolders: [],
      fs: {
        createDirectory: async () => undefined,
        readDirectory: async () => [],
        delete: async () => undefined,
        readFile: async () => Buffer.from(''),
        writeFile: async () => undefined
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const restore = installVscodeMock();
process.on('exit', restore);

const { ClientStatePersistence } = require('../dist/extension/backend/application/ClientStatePersistence.js');
const { StorageStateContributorsKey } = require('../dist/extension/backend/world/storageProjection/resources.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

const fakeResource = { name: 'testProjectionClock' };

class FakeWorld {
  constructor(state) {
    this.state = state;
    this.version = 1;
    this.registry = {
      list: () => [{
        key: 'test',
        reads: { resources: [fakeResource] },
        project: () => this.state
      }]
    };
  }

  setState(state) {
    this.state = state;
    this.version += 1;
  }

  tryGetResource(key) {
    return key === StorageStateContributorsKey ? this.registry : undefined;
  }

  componentVersion() { return 0; }
  resourceVersion(resource) { return resource === fakeResource ? this.version : 0; }
}

function makeState(conversationId) {
  const state = createEmptyClientState();
  state.conversations = [{ id: conversationId, title: conversationId, visibility: 'visible' }];
  state.agentConversationLinks = [{ id: `link-${conversationId}`, agentId: 'agent-main', conversationId, role: 'default' }];
  return state;
}

function makeStorage(overrides = {}) {
  const calls = [];
  return {
    calls,
    saveClientStateSkeleton: async (state) => { calls.push({ kind: 'skeleton', state: JSON.parse(JSON.stringify(state)) }); },
    saveConversationRenderDetail: async (conversationId, state) => { calls.push({ kind: 'render', conversationId, state }); },
    saveConversationRunHistory: async (conversationId, state, options) => { calls.push({ kind: 'runHistory', conversationId, state, options }); },
    upsertConversationHistoryEntry: async (entry) => { calls.push({ kind: 'history', entry }); },
    ...overrides
  };
}

test('in-flight persist and exclusive mutation gate are mutually exclusive', async () => {
  const state = makeState('conversation-a');
  const world = new FakeWorld(state);
  const saveStarted = deferred();
  const releaseSave = deferred();
  const storage = makeStorage({
    saveClientStateSkeleton: async (snapshot) => {
      storage.calls.push({ kind: 'skeleton-start', state: snapshot });
      saveStarted.resolve();
      await releaseSave.promise;
      storage.calls.push({ kind: 'skeleton-end', state: snapshot });
    }
  });
  const persistence = new ClientStatePersistence(world, storage, {}, 5);
  persistence.enable();

  const persistPromise = persistence.persistImmediately({ force: true, throwOnError: true });
  await saveStarted.promise;

  let gateEntered = false;
  const gatePromise = persistence.withExclusiveMutationGate(async () => { gateEntered = true; });
  await delay(25);
  assert.equal(gateEntered, false, 'gate must wait for already-started persist to finish');

  releaseSave.resolve();
  await Promise.all([persistPromise, gatePromise]);
  assert.equal(gateEntered, true);
  assert.deepEqual(storage.calls.map((call) => call.kind), ['skeleton-start', 'skeleton-end']);
});

test('external persist during gate waits and cannot revive deleted conversation skeleton', async () => {
  const world = new FakeWorld(makeState('conversation-delete'));
  const storage = makeStorage();
  const persistence = new ClientStatePersistence(world, storage, {}, 5);
  persistence.enable();

  const gateEntered = deferred();
  const releaseGate = deferred();
  const gatePromise = persistence.withExclusiveMutationGate(async () => {
    gateEntered.resolve();
    await releaseGate.promise;
    world.setState(createEmptyClientState());
    persistence.discardConversation('conversation-delete');
    await persistence.persistImmediately({ force: true, throwOnError: true });
  });

  await gateEntered.promise;
  const externalPersist = persistence.persistImmediately({ force: true, throwOnError: true });
  await delay(25);
  assert.equal(storage.calls.length, 0, 'external persist must queue behind active gate');

  releaseGate.resolve();
  await Promise.all([gatePromise, externalPersist]);
  assert.ok(storage.calls.length >= 1);
  for (const call of storage.calls.filter((item) => item.kind === 'skeleton')) {
    assert.equal(call.state.conversations.some((conversation) => conversation.id === 'conversation-delete'), false);
    assert.equal(call.state.agentConversationLinks.some((link) => link.conversationId === 'conversation-delete'), false);
  }
});

test('explicit persist inside exclusive mutation gate does not deadlock', async () => {
  const world = new FakeWorld(makeState('conversation-safe'));
  const storage = makeStorage();
  const persistence = new ClientStatePersistence(world, storage, {}, 5);
  persistence.enable();

  await persistence.withExclusiveMutationGate(async () => {
    await persistence.persistImmediately({ force: true, throwOnError: true });
  });

  assert.equal(storage.calls.filter((call) => call.kind === 'skeleton').length, 1);
  assert.equal(storage.calls[0].state.conversations[0].id, 'conversation-safe');
});
