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
const {
  ConversationTimelineRevisionConflictError,
  applyConversationTimelinePatch,
  createConversationTimelinePatch
} = require('../dist/extension/backend/capabilities/vscodeStorage/conversationTimelinePatch.js');

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

let testTimelineCommitSeq = 0;

function timelineSaveResult(state) {
  testTimelineCommitSeq += 1;
  return { state, commitSeq: testTimelineCommitSeq, committedAt: 1_700_000_000_000 + testTimelineCommitSeq };
}

function makeStorage(overrides = {}) {
  const calls = [];
  return {
    calls,
    loadConversationDetail: async () => undefined,
    saveClientStateSkeleton: async (patch) => { calls.push({ kind: 'skeleton', patch: JSON.parse(JSON.stringify(patch)) }); },
    saveConversationRenderDetail: async (conversationId, base, state) => {
      calls.push({ kind: 'render', conversationId, base, state });
      return timelineSaveResult(state);
    },
    saveConversationTimelineRenderDetail: async (conversationId, base, state) => {
      calls.push({ kind: 'timeline-render', conversationId, base, state });
      return timelineSaveResult(state);
    },
    saveConversationRunHistory: async (conversationId, state, options) => { calls.push({ kind: 'runHistory', conversationId, state, options }); },
    upsertConversationHistoryEntry: async (entry) => { calls.push({ kind: 'history', entry }); },
    ...overrides
  };
}

function addCompletedCheckpointGraph(state, conversationId, updatedAt) {
  const messageId = `message-${conversationId}`;
  const projectContextId = `project-${conversationId}`;
  const shadowRepositoryId = `shadow-${conversationId}`;
  const linkId = `checkpoint-repository-${conversationId}`;
  const checkpointId = `checkpoint-${conversationId}`;
  state.messages.push({
    id: messageId,
    conversationId,
    role: 'user',
    content: { parts: [{ text: 'checkpoint persistence' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  state.projectContexts.push({
    id: projectContextId,
    kind: 'folder',
    uri: 'file:///workspace/project',
    name: 'project',
    createdAt: 1,
    updatedAt: 1
  });
  state.shadowRepositories.push({
    id: shadowRepositoryId,
    storageKey: `storage-${conversationId}`,
    createdAt: 1,
    updatedAt
  });
  state.conversationCheckpointRepositoryLinks.push({
    id: linkId,
    conversationId,
    projectContextId,
    shadowRepositoryId,
    projectUri: 'file:///workspace/project',
    projectDisplayPath: '/workspace/project',
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });
  state.checkpoints.push({
    id: checkpointId,
    conversationId,
    projectContextId,
    shadowRepositoryId,
    trigger: 'user_message_before',
    status: 'created',
    projectUri: 'file:///workspace/project',
    projectDisplayPath: '/workspace/project',
    createdAt: 1,
    updatedAt: 2
  });
  state.checkpointTimelineAnchors.push({
    id: `checkpoint-anchor-${conversationId}`,
    conversationId,
    checkpointId,
    floorMessageId: messageId,
    position: 'before',
    order: 1,
    createdAt: 2,
    updatedAt: 2
  });
  return { projectContextId, shadowRepositoryId, linkId };
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

test('按需加载旧 range 会扩展已确认 base，重试前保存不再把旧消息声明为新增', async () => {
  const conversationId = 'conversation-range-base';
  const oldRange = makeState(conversationId);
  oldRange.messages.push({
    id: 'message-old-range',
    conversationId,
    role: 'user',
    content: { parts: [{ text: 'persisted old message' }] },
    status: 'complete',
    createdAt: 1,
    requestStartedAt: 10,
    seq: 1
  });
  const tail = makeState(conversationId);
  tail.messages.push({
    id: 'message-tail-range',
    conversationId,
    role: 'model',
    content: { parts: [{ text: 'persisted tail' }] },
    status: 'complete',
    createdAt: 2,
    seq: 2
  });
  const disk = makeState(conversationId);
  disk.messages = [...oldRange.messages, ...tail.messages];
  const projected = makeState(conversationId);
  projected.messages = [...tail.messages, ...oldRange.messages];
  const projectedWithOldHydrationBug = JSON.parse(JSON.stringify(projected));
  delete projectedWithOldHydrationBug.messages.find((message) => message.id === 'message-old-range').requestStartedAt;

  assert.throws(
    () => applyConversationTimelinePatch(
      conversationId,
      JSON.parse(JSON.stringify(disk)),
      createConversationTimelinePatch(tail, projectedWithOldHydrationBug)
    ),
    /expected=missing, actual=sha256:/,
    '旧 range 未进入 base 时应精确复现线上 expected=missing 冲突'
  );

  const saveAttempts = [];
  const storage = makeStorage({
    saveConversationTimelineRenderDetail: async (id, base, state) => {
      const patch = createConversationTimelinePatch(base, state);
      saveAttempts.push({
        id,
        base: JSON.parse(JSON.stringify(base)),
        state: JSON.parse(JSON.stringify(state)),
        patch
      });
      applyConversationTimelinePatch(id, JSON.parse(JSON.stringify(disk)), patch);
      return timelineSaveResult(state);
    }
  });
  const persistence = new ClientStatePersistence(new FakeWorld(projected), storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false,
    projectConversationTimelineState: () => projected
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, tail);
  persistence.extendConversationRenderDetailPersistedRange(conversationId, oldRange);
  persistence.enable({ skeleton: false });

  await persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true });

  assert.equal(saveAttempts.length, 1);
  assert.deepEqual(
    new Set(saveAttempts[0].base.messages.map((message) => message.id)),
    new Set(['message-old-range', 'message-tail-range'])
  );
  assert.deepEqual(saveAttempts[0].patch, {});
});

test('较早 range 中的同 id record 不会倒退已经确认的 CAS base', async () => {
  const conversationId = 'conversation-range-stale-overlap';
  const acknowledged = makeState(conversationId);
  acknowledged.messages.push({
    id: 'message-overlap',
    conversationId,
    role: 'model',
    content: { parts: [{ text: 'complete output' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  const staleRange = JSON.parse(JSON.stringify(acknowledged));
  staleRange.messages[0].content = { parts: [{ text: 'partial' }] };
  staleRange.messages[0].status = 'streaming';

  const bases = [];
  const storage = makeStorage({
    saveConversationTimelineRenderDetail: async (_id, base, state) => {
      bases.push(JSON.parse(JSON.stringify(base)));
      return timelineSaveResult(state);
    }
  });
  const persistence = new ClientStatePersistence(new FakeWorld(acknowledged), storage, {
    projectConversationTimelineState: () => acknowledged
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, acknowledged);
  persistence.extendConversationRenderDetailPersistedRange(conversationId, staleRange);
  persistence.enable({ skeleton: false });

  await persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true });

  assert.equal(bases[0].messages[0].status, 'complete');
  assert.equal(bases[0].messages[0].content.parts[0].text, 'complete output');
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
      return timelineSaveResult(snapshot);
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

test('skeleton 冲突不会把已成功保存的 render detail 重新放回 pending', async () => {
  const firstConversationId = 'conversation-skeleton-conflict-a';
  const secondConversationId = 'conversation-skeleton-conflict-b';
  const state = createEmptyClientState();
  state.conversations = [
    { id: firstConversationId, title: firstConversationId, visibility: 'visible' },
    { id: secondConversationId, title: secondConversationId, visibility: 'visible' }
  ];
  state.messages = [
    {
      id: 'message-skeleton-conflict-a',
      conversationId: firstConversationId,
      role: 'user',
      content: { parts: [{ text: 'A 应该正常落盘' }] },
      status: 'complete',
      createdAt: 1,
      seq: 1
    },
    {
      id: 'message-skeleton-conflict-b',
      conversationId: secondConversationId,
      role: 'user',
      content: { parts: [{ text: 'B 也不应被 skeleton 污染' }] },
      status: 'complete',
      createdAt: 2,
      seq: 1
    }
  ];
  const world = new FakeWorld(state);
  let skeletonAttempts = 0;
  const storage = makeStorage({
    saveClientStateSkeleton: async () => {
      skeletonAttempts += 1;
      const error = new Error('synthetic skeleton conflict');
      error.clientStateSkeletonRevisionConflict = true;
      throw error;
    }
  });
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [firstConversationId, secondConversationId],
    isConversationHistorySummaryComplete: () => false
  }, 5);
  persistence.enable();

  await persistence.persistImmediately({ force: true });
  assert.equal(skeletonAttempts, 1);
  assert.deepEqual(storage.calls.filter((call) => call.kind === 'render').map((call) => call.conversationId).sort(), [
    firstConversationId,
    secondConversationId
  ]);

  storage.calls.length = 0;
  await persistence.persistImmediately();
  assert.equal(skeletonAttempts, 2);
  assert.equal(storage.calls.filter((call) => call.kind === 'render').length, 0, '已成功的对话 render detail 不应因 skeleton pending 被反复保存');
});

test('timeline 缺失已确认 sidecar 时会重读磁盘并有界 rebase，不保留永久 stale base', async () => {
  const conversationId = 'conversation-missing-sidecar-rebase';
  const acknowledged = makeState(conversationId);
  const ids = addCompletedCheckpointGraph(acknowledged, conversationId, 10);
  const next = JSON.parse(JSON.stringify(acknowledged));
  next.shadowRepositories[0].updatedAt = 20;

  const disk = JSON.parse(JSON.stringify(acknowledged));
  disk.projectContexts = [];
  disk.shadowRepositories = [];
  disk.conversationCheckpointRepositoryLinks = [];

  const world = new FakeWorld(next);
  let attempts = 0;
  let reloads = 0;
  const saveAttempts = [];
  const storage = makeStorage({
    loadConversationDetail: async (id) => {
      assert.equal(id, conversationId);
      reloads += 1;
      return JSON.parse(JSON.stringify(disk));
    },
    saveConversationRenderDetail: async (id, base, state) => {
      attempts += 1;
      saveAttempts.push({
        id,
        base: JSON.parse(JSON.stringify(base)),
        state: JSON.parse(JSON.stringify(state))
      });
      if (attempts === 1) {
        throw new ConversationTimelineRevisionConflictError(
          conversationId,
          'shadowRepositories',
          ids.shadowRepositoryId,
          'sha256:stale-local-base',
          null
        );
      }
      return timelineSaveResult(state);
    }
  });
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, acknowledged);
  persistence.enable({ skeleton: false });

  await persistence.persistImmediately({ throwOnError: true });

  assert.equal(attempts, 2);
  assert.equal(reloads, 1);
  assert.deepEqual(saveAttempts[1].base.projectContexts, []);
  assert.deepEqual(saveAttempts[1].base.shadowRepositories, []);
  assert.deepEqual(saveAttempts[1].base.conversationCheckpointRepositoryLinks, []);
  assert.deepEqual(saveAttempts[1].state.projectContexts.map((record) => record.id), [ids.projectContextId]);
  assert.deepEqual(saveAttempts[1].state.shadowRepositories.map((record) => record.id), [ids.shadowRepositoryId]);
  assert.deepEqual(saveAttempts[1].state.conversationCheckpointRepositoryLinks.map((record) => record.id), [ids.linkId]);
  assert.equal(persistence.statusSnapshot().phase, 'saved');

  await persistence.persistImmediately();
  assert.equal(attempts, 2, '成功 rebase 后相同状态不应再次保存');
});

test('消息重试前的 timeline 强制保存也会修复缺失 sidecar base', async () => {
  const conversationId = 'conversation-retry-mutation-sidecar-rebase';
  const acknowledged = makeState(conversationId);
  const ids = addCompletedCheckpointGraph(acknowledged, conversationId, 10);
  const next = JSON.parse(JSON.stringify(acknowledged));
  next.shadowRepositories[0].updatedAt = 20;

  const disk = JSON.parse(JSON.stringify(acknowledged));
  disk.projectContexts = [];
  disk.shadowRepositories = [];
  disk.conversationCheckpointRepositoryLinks = [];

  let attempts = 0;
  let reloads = 0;
  const saveAttempts = [];
  const storage = makeStorage({
    loadConversationDetail: async (id) => {
      assert.equal(id, conversationId);
      reloads += 1;
      return JSON.parse(JSON.stringify(disk));
    },
    saveConversationTimelineRenderDetail: async (id, base, state) => {
      attempts += 1;
      saveAttempts.push({
        id,
        base: JSON.parse(JSON.stringify(base)),
        state: JSON.parse(JSON.stringify(state))
      });
      if (attempts === 1) {
        throw new ConversationTimelineRevisionConflictError(
          conversationId,
          'shadowRepositories',
          ids.shadowRepositoryId,
          'sha256:stale-local-base',
          null
        );
      }
      return timelineSaveResult(state);
    }
  });
  const persistence = new ClientStatePersistence(new FakeWorld(next), storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false,
    projectConversationTimelineState: () => next
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, acknowledged);
  persistence.enable({ skeleton: false });

  await persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true });

  assert.equal(attempts, 2);
  assert.equal(reloads, 1);
  assert.deepEqual(saveAttempts[1].base.projectContexts, []);
  assert.deepEqual(saveAttempts[1].base.shadowRepositories, []);
  assert.deepEqual(saveAttempts[1].base.conversationCheckpointRepositoryLinks, []);
  assert.deepEqual(saveAttempts[1].state.projectContexts.map((record) => record.id), [ids.projectContextId]);
  assert.deepEqual(saveAttempts[1].state.shadowRepositories.map((record) => record.id), [ids.shadowRepositoryId]);
  assert.deepEqual(saveAttempts[1].state.conversationCheckpointRepositoryLinks.map((record) => record.id), [ids.linkId]);
});

test('消息重试前遇到已提交 ToolCall 终态时会重读并刷新 stale executing base', async () => {
  const conversationId = 'conversation-stale-tool-call-rebase';
  const messageId = 'message-stale-tool-call-rebase';
  const toolCallId = 'tc-stale-tool-call-rebase';
  const acknowledged = makeState(conversationId);
  acknowledged.messages.push({
    id: messageId,
    conversationId,
    role: 'model',
    content: { parts: [{ text: 'tool call' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  acknowledged.toolCalls.push({
    id: toolCallId,
    messageId,
    name: 'read',
    functionCallId: 'function-stale-tool-call-rebase',
    args: '{"path":"README.md"}',
    status: 'executing',
    createdAt: 10,
    updatedAt: 11
  });
  acknowledged.toolCallEvents.push(
    { id: 'tce-stale-created', toolCallId, seq: 1, kind: 'created', at: 10, status: 'queued' },
    { id: 'tce-stale-started', toolCallId, seq: 2, kind: 'started', at: 11, status: 'executing' }
  );

  let projected = JSON.parse(JSON.stringify(acknowledged));
  projected.toolCalls[0] = {
    ...projected.toolCalls[0],
    status: 'error',
    error: 'late local fallback',
    updatedAt: 30
  };
  projected.toolCallEvents.push({
    id: 'tce-stale-local-failed',
    toolCallId,
    seq: 3,
    kind: 'failed',
    at: 30,
    status: 'error',
    error: 'late local fallback'
  });

  let disk = JSON.parse(JSON.stringify(acknowledged));
  disk.toolCalls[0] = {
    ...disk.toolCalls[0],
    status: 'error',
    error: 'canonical recovery result',
    updatedAt: 20
  };

  let attempts = 0;
  let reloads = 0;
  const saveAttempts = [];
  const storage = makeStorage({
    loadConversationDetail: async () => {
      reloads += 1;
      return JSON.parse(JSON.stringify(disk));
    },
    saveConversationTimelineRenderDetail: async (id, base, state) => {
      attempts += 1;
      saveAttempts.push({
        base: JSON.parse(JSON.stringify(base)),
        state: JSON.parse(JSON.stringify(state))
      });
      const patch = createConversationTimelinePatch(base, state);
      const applied = applyConversationTimelinePatch(id, JSON.parse(JSON.stringify(disk)), patch);
      disk = applied.state;
      return timelineSaveResult(state);
    }
  });
  const persistence = new ClientStatePersistence(new FakeWorld(projected), storage, {
    projectConversationTimelineState: () => projected
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, acknowledged);
  persistence.enable({ skeleton: false });

  await persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true });

  assert.equal(attempts, 2);
  assert.equal(reloads, 1);
  assert.equal(saveAttempts[0].base.toolCalls[0].status, 'executing');
  assert.equal(saveAttempts[0].state.toolCalls[0].error, 'late local fallback');
  assert.equal(saveAttempts[1].base.toolCalls[0].error, 'canonical recovery result');
  assert.equal(saveAttempts[1].state.toolCalls[0].error, 'canonical recovery result');
  assert.deepEqual(saveAttempts[1].state.toolCallEvents.map((event) => event.id), [
    'tce-stale-created',
    'tce-stale-started'
  ]);
  assert.equal(disk.toolCalls[0].error, 'canonical recovery result');

  // 相同 stale ECS 快照再次执行“重试前保存”时，不能反向覆盖刚确认的 canonical 终态。
  await persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true });
  assert.equal(attempts, 3);
  assert.equal(reloads, 1);
  assert.equal(saveAttempts[2].base.toolCalls[0].error, 'canonical recovery result');
  assert.equal(saveAttempts[2].state.toolCalls[0].error, 'canonical recovery result');
  assert.equal(disk.toolCalls[0].error, 'canonical recovery result');

  // 真正的 retry/truncate 删除该 ToolCall 后，override 必须释放并按 canonical revision 删除。
  projected = JSON.parse(JSON.stringify(projected));
  projected.toolCalls = [];
  projected.toolCallEvents = [];
  await persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true });
  assert.equal(attempts, 4);
  assert.deepEqual(disk.toolCalls, []);
  assert.deepEqual(disk.toolCallEvents, []);
});

test('基于旧终态产生的真实 ToolCall 并发修改仍然明确冲突', async () => {
  const conversationId = 'conversation-terminal-tool-call-conflict';
  const messageId = 'message-terminal-tool-call-conflict';
  const toolCallId = 'tc-terminal-tool-call-conflict';
  const acknowledged = makeState(conversationId);
  acknowledged.messages.push({
    id: messageId,
    conversationId,
    role: 'model',
    content: { parts: [{ text: 'tool call' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  acknowledged.toolCalls.push({
    id: toolCallId,
    messageId,
    name: 'read',
    args: '{}',
    status: 'error',
    error: 'original terminal result',
    createdAt: 10,
    updatedAt: 20
  });
  const projected = JSON.parse(JSON.stringify(acknowledged));
  projected.toolCalls[0] = {
    ...projected.toolCalls[0],
    status: 'awaiting_result_submit',
    updatedAt: 30
  };
  const disk = JSON.parse(JSON.stringify(acknowledged));
  disk.toolCalls[0] = {
    ...disk.toolCalls[0],
    status: 'success',
    result: { ok: true },
    error: undefined,
    updatedAt: 25
  };

  let attempts = 0;
  let reloads = 0;
  const storage = makeStorage({
    loadConversationDetail: async () => {
      reloads += 1;
      return JSON.parse(JSON.stringify(disk));
    },
    saveConversationTimelineRenderDetail: async (id, base, state) => {
      attempts += 1;
      const patch = createConversationTimelinePatch(base, state);
      applyConversationTimelinePatch(id, JSON.parse(JSON.stringify(disk)), patch);
      return timelineSaveResult(state);
    }
  });
  const persistence = new ClientStatePersistence(new FakeWorld(projected), storage, {
    projectConversationTimelineState: () => projected
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, acknowledged);
  persistence.enable({ skeleton: false });

  await assert.rejects(
    persistence.persistConversationRenderDetailImmediately(conversationId, { throwOnError: true }),
    /Conversation timeline conflict.*tc-terminal-tool-call-conflict/
  );
  assert.equal(attempts, 1);
  assert.equal(reloads, 1);
});

test('磁盘 checkpoint 也已删除时不自动复活 sidecar', async () => {
  const conversationId = 'conversation-deleted-checkpoint-conflict';
  const acknowledged = makeState(conversationId);
  const ids = addCompletedCheckpointGraph(acknowledged, conversationId, 10);
  const next = JSON.parse(JSON.stringify(acknowledged));
  next.shadowRepositories[0].updatedAt = 20;
  const disk = JSON.parse(JSON.stringify(acknowledged));
  disk.projectContexts = [];
  disk.shadowRepositories = [];
  disk.conversationCheckpointRepositoryLinks = [];
  disk.checkpoints = [];
  disk.checkpointTimelineAnchors = [];

  let attempts = 0;
  let reloads = 0;
  const storage = makeStorage({
    loadConversationDetail: async () => {
      reloads += 1;
      return disk;
    },
    saveConversationRenderDetail: async () => {
      attempts += 1;
      throw new ConversationTimelineRevisionConflictError(
        conversationId,
        'shadowRepositories',
        ids.shadowRepositoryId,
        'sha256:deleted-by-another-writer',
        null
      );
    }
  });
  const persistence = new ClientStatePersistence(new FakeWorld(next), storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, acknowledged);
  persistence.enable({ skeleton: false });

  await assert.rejects(
    persistence.persistImmediately({ throwOnError: true }),
    /Conversation timeline conflict/
  );
  assert.equal(attempts, 1);
  assert.equal(reloads, 1);
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
      return timelineSaveResult(snapshot);
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

test('timeline 结构元数据不变时，sidecar-only 提交仍会逐次发布精确 patch', async () => {
  const conversationId = 'conversation-sidecar-patch';
  const base = makeState(conversationId);
  base.messages.push({
    id: 'message-sidecar-patch',
    conversationId,
    role: 'user',
    content: { parts: [{ text: 'sidecar patch' }] },
    status: 'complete',
    createdAt: 1,
    seq: 1
  });
  base.compressionBlocks.push({
    id: 'compression-sidecar-patch',
    conversationId,
    title: 'summary',
    status: 'complete',
    methodKind: 'llm_summary',
    anchorSeq: 1,
    endSeq: 1,
    summaryPreview: 'v1',
    createdAt: 1,
    updatedAt: 1
  });

  const next = JSON.parse(JSON.stringify(base));
  next.compressionBlocks[0].summaryPreview = 'v2';
  next.compressionBlocks[0].updatedAt = 2;
  const world = new FakeWorld(next);
  const publishedPatches = [];
  const publishedMeta = [];
  const metadata = {
    conversationId,
    commitSeq: 0,
    revision: 'same-message-index-revision',
    totalChunks: 1,
    totalMessages: 1,
    oldestChunk: { id: '000000', index: 0, startSeq: 1, endSeq: 1, messageCount: 1, messageOffsetStart: 1, messageOffsetEnd: 1, toolCallCount: 0, toolCallEventCount: 0 },
    newestChunk: { id: '000000', index: 0, startSeq: 1, endSeq: 1, messageCount: 1, messageOffsetStart: 1, messageOffsetEnd: 1, toolCallCount: 0, toolCallEventCount: 0 },
    committedAt: 1
  };
  const storage = makeStorage({ loadConversationTimelineMeta: async () => metadata });
  const persistence = new ClientStatePersistence(world, storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false,
    onConversationTimelinePatched: (payload) => publishedPatches.push(payload),
    onConversationTimelineCommitted: (payload) => publishedMeta.push(payload)
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, base);
  persistence.enable({ skeleton: false });

  await persistence.persistImmediately({ force: true, throwOnError: true });
  const latest = JSON.parse(JSON.stringify(next));
  latest.compressionBlocks[0].summaryPreview = 'v3';
  latest.compressionBlocks[0].updatedAt = 3;
  world.setState(latest);
  await persistence.persistImmediately({ force: true, throwOnError: true });

  assert.equal(publishedPatches.length, 2);
  assert.ok(publishedPatches[0].commitSeq < publishedPatches[1].commitSeq);
  assert.deepEqual(
    publishedPatches.map((payload) => payload.patches.map((patch) => patch.kind)),
    [['compressionBlock.upsert'], ['compressionBlock.upsert']]
  );
  assert.equal(publishedMeta.length, 1, '结构相同的 meta 可以去重，但不能吞掉 sidecar patch');
});

test('timeline meta 读取失败不会吞掉已提交的精确 patch', async () => {
  const conversationId = 'conversation-patch-before-meta';
  const base = makeState(conversationId);
  base.messages.push({ id: 'message-patch-before-meta', conversationId, role: 'user', content: { parts: [{ text: 'v1' }] }, status: 'complete', createdAt: 1, seq: 1 });
  const next = JSON.parse(JSON.stringify(base));
  next.messages[0].content = { parts: [{ text: 'v2' }] };
  const patches = [];
  const metadata = [];
  const storage = makeStorage({
    loadConversationTimelineMeta: async () => { throw new Error('meta unavailable'); }
  });
  const persistence = new ClientStatePersistence(new FakeWorld(next), storage, {
    renderLoadedConversationIds: () => [conversationId],
    isConversationHistorySummaryComplete: () => false,
    onConversationTimelinePatched: (payload) => patches.push(payload),
    onConversationTimelineCommitted: (payload) => metadata.push(payload)
  }, 5);
  persistence.rememberConversationRenderDetailPersisted(conversationId, base);
  persistence.enable({ skeleton: false });

  await persistence.persistImmediately({ force: true, throwOnError: true });

  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].patches.map((patch) => patch.kind), ['message.upsert']);
  assert.equal(metadata.length, 0);
  assert.equal(persistence.statusSnapshot().phase, 'saved');
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
