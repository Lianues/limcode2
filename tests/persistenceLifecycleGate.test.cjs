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
    saveClientStateSkeleton: async (patch) => { calls.push({ kind: 'skeleton', patch: JSON.parse(JSON.stringify(patch)) }); },
    saveConversationRenderDetail: async (conversationId, base, state) => { calls.push({ kind: 'render', conversationId, base, state }); },
    saveConversationTimelineRenderDetail: async (conversationId, base, state) => { calls.push({ kind: 'timeline-render', conversationId, base, state }); },
    saveConversationRunHistory: async (conversationId, state, options) => { calls.push({ kind: 'runHistory', conversationId, state, options }); },
    upsertConversationHistoryEntry: async (entry) => { calls.push({ kind: 'history', entry }); },
    ...overrides
  };
}

test('skeleton 不健康时 timeline 仍独立启用并持久化聊天，未启用时强制保存明确失败', async () => {
  const conversationId = 'conversation-timeline-health-split';
  const state = makeState(conversationId);
  state.messages.push({
    id: 'message-timeline-health-split',
    conversationId,
    role: 'user',
    content: { parts: [{ text: 'metadata 损坏也不能让聊天静默不落盘' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  const world = new FakeWorld(state);
  const disabledStorage = makeStorage();
  const disabled = new ClientStatePersistence(world, disabledStorage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false
  }, 5);
  await assert.rejects(
    disabled.persistImmediately({ ensurePersisted: true, throwOnError: true }),
    /timeline persistence is not enabled/
  );

  const storage = makeStorage();
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false
  }, 5);
  persistence.enable({ skeleton: false });
  await persistence.persistImmediately({ force: true, throwOnError: true });
  assert.equal(storage.calls.filter((call) => call.kind === 'render').length, 1);
  assert.equal(storage.calls.filter((call) => call.kind === 'skeleton').length, 0);
});

test('tail-only hydrate 会作为已知 record base，后续追加不会把旧 tail 重新声明为新增', async () => {
  const conversationId = 'conversation-tail-base';
  const tail = makeState(conversationId);
  tail.messages.push({
    id: 'stream-tail-base',
    conversationId,
    role: 'model',
    content: { parts: [{ text: 'old partial' }] },
    status: 'streaming',
    createdAt: 1,
    seq: 1
  });
  const next = JSON.parse(JSON.stringify(tail));
  next.messages.push({
    id: 'append-after-tail',
    conversationId,
    role: 'user',
    content: { parts: [{ text: 'new append' }] },
    status: 'complete',
    createdAt: 2,
    seq: 2
  });
  const world = new FakeWorld(next);
  const storage = makeStorage();
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, tail);
  persistence.enable({ skeleton: false });
  await persistence.persistImmediately({ force: true, throwOnError: true });

  const render = storage.calls.find((call) => call.kind === 'render');
  assert.ok(render);
  assert.deepEqual(render.base.messages.map((message) => message.id), ['stream-tail-base']);
  assert.deepEqual(render.state.messages.map((message) => message.id), ['stream-tail-base', 'append-after-tail']);
});

test('render detail 会在慢 skeleton 完成前先预订并启动保存', async () => {
  const conversationId = 'conversation-render-first';
  const state = makeState(conversationId);
  state.messages.push({
    id: 'message-render-first',
    conversationId,
    role: 'user',
    content: { parts: [{ text: '先保存 timeline' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  const world = new FakeWorld(state);
  const skeletonStarted = deferred();
  const releaseSkeleton = deferred();
  const renderStarted = deferred();
  const storage = makeStorage({
    saveClientStateSkeleton: async () => {
      storage.calls.push({ kind: 'skeleton-start' });
      skeletonStarted.resolve();
      await releaseSkeleton.promise;
      storage.calls.push({ kind: 'skeleton-end' });
    },
    saveConversationRenderDetail: async (id, base, snapshot) => {
      storage.calls.push({ kind: 'render-start', conversationId: id, base, state: snapshot });
      renderStarted.resolve();
    }
  });
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false
  }, 5);
  persistence.enable();

  const persistPromise = persistence.persistImmediately({ force: true, throwOnError: true });
  await Promise.all([skeletonStarted.promise, renderStarted.promise]);

  assert.equal(storage.calls[0].kind, 'render-start');
  assert.equal(storage.calls.some((call) => call.kind === 'skeleton-end'), false);
  releaseSkeleton.resolve();
  await persistPromise;
});

test('timeline-only 强制保存不等待正在进行的慢 run history', async () => {
  const conversationId = 'conversation-targeted-render';
  const state = makeState(conversationId);
  state.messages.push({
    id: 'message-targeted-render',
    conversationId,
    role: 'user',
    content: { parts: [{ text: '只等待 timeline' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  state.agentRuns.push({ id: 'run-targeted-render', kind: 'chat', status: 'completed', createdAt: 1, updatedAt: 1 });
  state.agentRunTargetLinks.push({
    id: 'run-target-targeted-render',
    runId: 'run-targeted-render',
    agentId: 'agent-main',
    conversationId,
    role: 'primary',
    createdAt: 1,
    updatedAt: 1
  });
  const world = new FakeWorld(state);
  const runHistoryStarted = deferred();
  const releaseRunHistory = deferred();
  const storage = makeStorage({
    saveConversationRunHistory: async () => {
      storage.calls.push({ kind: 'run-history-start' });
      runHistoryStarted.resolve();
      await releaseRunHistory.promise;
      storage.calls.push({ kind: 'run-history-end' });
    }
  });
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    runHistoryLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false,
    projectConversationTimelineState: () => state
  }, 5);
  persistence.enable();

  const fullPersist = persistence.persistImmediately({ force: true, throwOnError: true });
  await runHistoryStarted.promise;
  const targetedPersist = persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true });
  const completedBeforeRunHistory = await Promise.race([
    targetedPersist.then(() => true),
    delay(50).then(() => false)
  ]);

  assert.equal(completedBeforeRunHistory, true);
  assert.equal(storage.calls.filter((call) => call.kind === 'render').length, 1);
  assert.equal(storage.calls.filter((call) => call.kind === 'timeline-render').length, 1);
  assert.equal(storage.calls.some((call) => call.kind === 'run-history-end'), false);

  releaseRunHistory.resolve();
  await fullPersist;
});

test('完整上下文读取屏障会先提交 timeline，并阻止 debounce writer 并发', async () => {
  const conversationId = 'conversation-context-read-barrier';
  const state = makeState(conversationId);
  state.messages.push({
    id: 'message-context-read-barrier',
    conversationId,
    role: 'user',
    content: { parts: [{ text: 'edited tail' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  const world = new FakeWorld(state);
  const timelineStarted = deferred();
  const releaseTimeline = deferred();
  const contextReadStarted = deferred();
  const releaseContextRead = deferred();
  const storage = makeStorage({
    saveConversationTimelineRenderDetail: async (id, base, snapshot) => {
      storage.calls.push({ kind: 'timeline-render-start', conversationId: id, base, state: snapshot });
      timelineStarted.resolve();
      await releaseTimeline.promise;
      storage.calls.push({ kind: 'timeline-render-end', conversationId: id });
    }
  });
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false,
    projectConversationTimelineState: () => {
      const detail = createEmptyClientState();
      detail.messages = [...world.state.messages];
      return detail;
    }
  }, 5);
  persistence.enable();

  // 先存在一个 debounce 保存；进入屏障后不能丢失，也不能在 context read 中途执行。
  persistence.queuePersist();
  const barrier = persistence.withConversationTimelineCommittedBeforeRead(conversationId, async () => {
    storage.calls.push({ kind: 'context-read-start' });
    contextReadStarted.resolve();
    persistence.queuePersist();
    await releaseContextRead.promise;
    storage.calls.push({ kind: 'context-read-end' });
  });

  await timelineStarted.promise;
  assert.equal(storage.calls.some((call) => call.kind === 'context-read-start'), false);
  releaseTimeline.resolve();
  await contextReadStarted.promise;
  assert.deepEqual(storage.calls.slice(0, 3).map((call) => call.kind), [
    'timeline-render-start',
    'timeline-render-end',
    'context-read-start'
  ]);
  await delay(20);
  assert.equal(storage.calls.some((call) => call.kind === 'render'), false);
  assert.equal(storage.calls.some((call) => call.kind === 'skeleton'), false);

  releaseContextRead.resolve();
  await barrier;
  await delay(20);
  assert.equal(storage.calls.filter((call) => call.kind === 'render').length, 0, 'unchanged committed timeline must not be saved again');
  assert.equal(storage.calls.filter((call) => call.kind === 'skeleton').length, 1, 'cleared pre-existing debounce persist must resume after barrier');
});

test('完整上下文读取屏障期间产生的新 timeline 变化会在退出后补保存', async () => {
  const conversationId = 'conversation-context-read-dirty';
  const initial = makeState(conversationId);
  initial.messages.push({
    id: 'message-context-read-dirty-1',
    conversationId,
    role: 'user',
    content: { parts: [{ text: 'committed before read' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  const world = new FakeWorld(initial);
  const contextReadStarted = deferred();
  const releaseContextRead = deferred();
  const storage = makeStorage();
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false,
    projectConversationTimelineState: () => {
      const detail = createEmptyClientState();
      detail.messages = [...world.state.messages];
      return detail;
    }
  }, 5);
  persistence.enable();

  const barrier = persistence.withConversationTimelineCommittedBeforeRead(conversationId, async () => {
    contextReadStarted.resolve();
    await releaseContextRead.promise;
  });
  await contextReadStarted.promise;

  const changed = makeState(conversationId);
  changed.messages = [
    ...initial.messages,
    {
      id: 'message-context-read-dirty-2',
      conversationId,
      role: 'model',
      content: { parts: [{ text: 'created during read' }] },
      status: 'complete',
      createdAt: 2,
      seq: 2
    }
  ];
  world.setState(changed);
  persistence.queuePersist();
  await delay(20);
  assert.equal(storage.calls.filter((call) => call.kind === 'render').length, 0);

  releaseContextRead.resolve();
  await barrier;
  await delay(30);
  const renderCalls = storage.calls.filter((call) => call.kind === 'render');
  assert.equal(renderCalls.length, 1);
  assert.deepEqual(renderCalls[0].state.messages.map((message) => message.id), [
    'message-context-read-dirty-1',
    'message-context-read-dirty-2'
  ]);
});

test('in-flight persist and exclusive mutation gate are mutually exclusive', async () => {
  const state = makeState('conversation-a');
  const world = new FakeWorld(state);
  const saveStarted = deferred();
  const releaseSave = deferred();
  const storage = makeStorage({
    saveClientStateSkeleton: async (patch) => {
      storage.calls.push({ kind: 'skeleton-start', patch });
      saveStarted.resolve();
      await releaseSave.promise;
      storage.calls.push({ kind: 'skeleton-end', patch });
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
  const initial = makeState('conversation-delete');
  const world = new FakeWorld(initial);
  const storage = makeStorage();
  const persistence = new ClientStatePersistence(world, storage, {}, 5);
  persistence.enable();
  persistence.rememberPersistedState(initial);

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
    assert.equal(call.patch.conversations?.upserts?.some((upsert) => upsert.record.id === 'conversation-delete') ?? false, false);
    assert.equal(call.patch.agentConversationLinks?.upserts?.some((upsert) => upsert.record.conversationId === 'conversation-delete') ?? false, false);
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
  assert.equal(storage.calls[0].patch.conversations.upserts[0].record.id, 'conversation-safe');
});

test('立即 queue 会暴露 pending/saving/saved，失败后按有限退避自动重试', async () => {
  const world = new FakeWorld(makeState('conversation-status'));
  const saved = deferred();
  const phases = [];
  let attempts = 0;
  const storage = makeStorage({
    saveClientStateSkeleton: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient disk failure');
      saved.resolve();
    }
  });
  const persistence = new ClientStatePersistence(world, storage, {
    onStatusChange: (status) => phases.push(status.phase),
    retryDelaysMs: [5]
  }, 500);
  persistence.enable();

  persistence.queuePersist({ delayMs: 0 });
  await saved.promise;
  await delay(20);

  assert.equal(attempts, 2);
  assert.ok(phases.includes('pending'));
  assert.ok(phases.includes('saving'));
  assert.ok(phases.includes('error'));
  assert.equal(phases.at(-1), 'saved');
});
