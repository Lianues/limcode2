const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static joinPath(base, ...segments) {
    return new MockUri(path.join(base.fsPath, ...segments));
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
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        delete: (uri, options = {}) => fs.rm(uri.fsPath, { recursive: options.recursive === true, force: false }),
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function removeTempRoot(target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code)) throw error;
      await delay(25 * attempt);
    }
  }
}

function shortHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function safeShardName(id) {
  const slug = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
  return `${slug}-${shortHash(id)}`;
}

function timelineRoot(paths, conversationId) {
  return path.join(paths.conversationsRootUri.fsPath, 'details', safeShardName(conversationId), 'messages');
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function fileSha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function chunkRefFiles(chunk) {
  return [
    chunk.file,
    ...Object.values(chunk.sidecars).map((ref) => ref.file),
    ...Object.values(chunk.projections).map((ref) => ref.file)
  ].sort();
}

async function collectChunkRefInfo(root, chunks) {
  const info = {};
  for (const chunk of chunks) {
    for (const file of chunkRefFiles(chunk)) {
      const absolutePath = path.join(root, file);
      const stat = await fs.stat(absolutePath);
      info[file] = {
        mtimeMs: stat.mtimeMs,
        hash: await fileSha256(absolutePath)
      };
    }
  }
  return info;
}

function tailToolCall(message, id = 'tool-tail-1') {
  return {
    id,
    messageId: message.id,
    name: 'tail_tool',
    args: '{}',
    status: 'success',
    result: { ok: true },
    createdAt: message.createdAt + 1,
    updatedAt: message.createdAt + 2
  };
}



function textMessage(conversationId, id, seq, text, role = 'user') {
  return {
    id,
    conversationId,
    role,
    content: { parts: [{ text }] },
    status: 'complete',
    createdAt: 1_700_000_000_000 + seq,
    seq
  };
}

function makeTimelineState(createEmptyClientState, conversationId, count, options = {}) {
  const state = createEmptyClientState();
  for (let index = 1; index <= count; index += 1) {
    state.messages.push(textMessage(conversationId, `${options.prefix ?? 'm'}-${index}`, index, `message ${index}`, index % 2 ? 'user' : 'model'));
  }
  if (options.withTaskListToolCall) {
    const message = state.messages[Math.min(1, state.messages.length - 1)];
    state.toolCalls.push({
      id: 'tool-task-list-1',
      messageId: message.id,
      name: 'update_task_list',
      args: JSON.stringify({
        mode: 'rewrite',
        items: [{ title: '梳理实现', description: 'timeline generation test', status: 'completed' }]
      }),
      status: 'success',
      result: { ok: true },
      createdAt: message.createdAt + 1,
      updatedAt: message.createdAt + 2
    });
  }
  return state;
}

function addCheckpointGraph(state, conversationId, options = {}) {
  const suffix = options.suffix ?? '1';
  const projectContextId = options.projectContextId ?? `project-${conversationId}`;
  const shadowRepositoryId = options.shadowRepositoryId ?? `shadow-${conversationId}`;
  const linkId = options.linkId ?? `checkpoint-repository-${conversationId}`;
  const checkpointId = `checkpoint-${conversationId}-${suffix}`;
  const createdAt = options.createdAt ?? 10;
  const updatedAt = options.updatedAt ?? createdAt;
  if (!state.projectContexts.some((record) => record.id === projectContextId)) {
    state.projectContexts.push({
      id: projectContextId,
      kind: 'folder',
      uri: 'file:///workspace/project',
      name: 'project',
      createdAt,
      updatedAt
    });
  }
  if (!state.shadowRepositories.some((record) => record.id === shadowRepositoryId)) {
    state.shadowRepositories.push({
      id: shadowRepositoryId,
      storageKey: `storage-${conversationId}`,
      createdAt,
      updatedAt
    });
  }
  if (!state.conversationCheckpointRepositoryLinks.some((record) => record.id === linkId)) {
    state.conversationCheckpointRepositoryLinks.push({
      id: linkId,
      conversationId,
      projectContextId,
      shadowRepositoryId,
      projectUri: 'file:///workspace/project',
      projectDisplayPath: '/workspace/project',
      role: 'active',
      createdAt,
      updatedAt
    });
  }
  state.checkpoints.push({
    id: checkpointId,
    conversationId,
    projectContextId,
    shadowRepositoryId,
    trigger: options.trigger ?? 'user_message_before',
    status: options.status ?? 'pending',
    projectUri: 'file:///workspace/project',
    projectDisplayPath: '/workspace/project',
    createdAt,
    updatedAt
  });
  if ((options.status ?? 'pending') !== 'pending') {
    state.checkpointTimelineAnchors.push({
      id: `checkpoint-anchor-${conversationId}-${suffix}`,
      conversationId,
      checkpointId,
      floorMessageId: options.floorMessageId ?? state.messages[0].id,
      position: 'before',
      order: options.order ?? 1,
      createdAt,
      updatedAt
    });
  }
  return { projectContextId, shadowRepositoryId, linkId, checkpointId };
}

const TIMELINE_TABLE_KEYS = [
  'messages', 'messageRevisions', 'messageCurrentRevisionLinks', 'toolCalls', 'toolCallEvents',
  'projectContexts', 'shadowRepositories', 'conversationCheckpointRepositoryLinks', 'checkpoints',
  'checkpointTimelineAnchors'
];

/** 把测试中的稀疏 upsert 输入转换为生产使用的 local base -> local next CAS 提交。 */
async function commitTimelinePatch(paths, conversationId, patch) {
  const base = await timelineStore.loadConversationTimelineDetail(paths, conversationId) ?? createEmptyClientState();
  const next = JSON.parse(JSON.stringify(base));
  for (const key of TIMELINE_TABLE_KEYS) {
    const records = patch[key] ?? [];
    if (records.length === 0) continue;
    const byId = new Map(next[key].map((record) => [record.id, record]));
    for (const record of records) byId.set(record.id, JSON.parse(JSON.stringify(record)));
    next[key] = [...byId.values()];
  }
  await timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, base, next);
  return true;
}

const restore = installVscodeMock();
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const timelineStore = require('../dist/extension/backend/capabilities/vscodeStorage/conversationTimelineStore.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const compressionStore = require('../dist/extension/backend/capabilities/vscodeStorage/compressionStore.js');
const timelineCommitStore = require('../dist/extension/backend/capabilities/vscodeStorage/conversationTimelineCommit.js');
const { createPersistedConversationTimelineClientPatches } = require('../dist/extension/backend/application/conversationTimelineClientPatch.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

test('timeline metadata 只读取 index 并准确报告 chunk 边界', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-meta-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-meta';
  try {
    await timelineStore.saveConversationTimelineDetail(
      paths,
      conversationId,
      makeTimelineState(createEmptyClientState, conversationId, 250)
    );

    const metadata = await timelineStore.loadConversationTimelineMeta(paths, conversationId);
    assert.ok(metadata.revision);
    assert.equal(metadata.totalChunks, 3);
    assert.equal(metadata.totalMessages, 250);
    assert.equal(metadata.oldestChunk.index, 0);
    assert.equal(metadata.oldestChunk.startSeq, 1);
    assert.equal(metadata.newestChunk.index, 2);
    assert.equal(metadata.newestChunk.endSeq, 250);

    const root = timelineRoot(paths, conversationId);
    const index = await readJsonFile(path.join(root, 'index.json'));
    await fs.writeFile(path.join(root, index.chunks[index.chunks.length - 1].file), '{broken-chunk', 'utf8');

    const metadataAfterChunkDamage = await timelineStore.loadConversationTimelineMeta(paths, conversationId);
    assert.equal(metadataAfterChunkDamage.revision, metadata.revision);
    assert.equal(metadataAfterChunkDamage.totalChunks, 3);
    assert.equal(metadataAfterChunkDamage.totalMessages, 250);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('newer 分页在 chunkCount=1 时仍会重读 cursor 并前进到后续 chunk', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-newer-refresh-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-newer-refresh';
  try {
    await timelineStore.saveConversationTimelineDetail(
      paths,
      conversationId,
      makeTimelineState(createEmptyClientState, conversationId, 150)
    );
    const initial = await timelineStore.loadConversationTimelinePage(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    assert.equal(initial.chunks.length, 1);
    assert.equal(initial.chunks[0].index, 1);
    assert.equal(initial.chunks[0].endSeq, 150);

    await timelineStore.saveConversationTimelineDetail(
      paths,
      conversationId,
      makeTimelineState(createEmptyClientState, conversationId, 250)
    );
    const newer = await timelineStore.loadConversationTimelinePage(paths, {
      conversationId,
      direction: 'newer',
      cursor: initial.chunks[0].id,
      chunkCount: 1
    });

    assert.deepEqual(newer.chunks.map((item) => item.index), [1, 2]);
    assert.equal(newer.chunks[0].endSeq, 200);
    assert.equal(newer.chunks[1].endSeq, 250);
    assert.equal(newer.state.messages[0].seq, 101);
    assert.equal(newer.state.messages[newer.state.messages.length - 1].seq, 250);

    const newestRefresh = await timelineStore.loadConversationTimelinePage(paths, {
      conversationId,
      direction: 'newer',
      cursor: newer.chunks[1].id,
      chunkCount: 1
    });
    assert.deepEqual(newestRefresh.chunks.map((item) => item.index), [2]);

    const missingCursor = await timelineStore.loadConversationTimelinePage(paths, {
      conversationId,
      direction: 'newer',
      cursor: 'missing-chunk',
      chunkCount: 1
    });
    assert.deepEqual(missingCursor.chunks.map((item) => item.index), [2]);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('compression canonical ACK 保留磁盘 sidecar，且 compression-only 提交推进统一 commitSeq', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-compression-canonical-ack-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-compression-canonical-ack';
  let releaseCompressionSave;
  try {
    const initial = makeTimelineState(createEmptyClientState, conversationId, 1);
    initial.compressionBlocks.push({
      id: 'compression-canonical',
      conversationId,
      title: 'summary',
      status: 'complete',
      methodKind: 'llm_summary',
      anchorMessageId: initial.messages[0].id,
      anchorSeq: 1,
      endSeq: 1,
      summaryPreview: 'v1',
      createdAt: 1,
      updatedAt: 1
    });
    initial.compressionBlockSourceLinks.push({
      id: 'compression-source-canonical',
      blockId: 'compression-canonical',
      sourceKind: 'message',
      sourceId: initial.messages[0].id,
      role: 'source',
      order: 1,
      createdAt: 1,
      updatedAt: 1
    });
    initial.compressionContextVariants.push({
      id: 'compression-variant-canonical',
      blockId: 'compression-canonical',
      kind: 'provider_neutral_summary',
      contents: [{ role: 'model', parts: [{ text: 'summary v1' }] }],
      createdAt: 1,
      updatedAt: 1
    });
    initial.compressionBlockLlmInvocationLinks.push({
      id: 'compression-invocation-link-canonical',
      blockId: 'compression-canonical',
      invocationId: 'compression-invocation-canonical',
      role: 'compact',
      createdAt: 1,
      updatedAt: 1
    });
    initial.llmInvocations.push({
      id: 'compression-invocation-canonical',
      requestId: 'compression-request-canonical',
      status: 'complete',
      createdAt: 1,
      completedAt: 1
    });

    const first = await clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      createEmptyClientState(),
      initial
    );
    assert.equal(first.commitSeq, 1);
    const firstPage = await clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    assert.equal(firstPage.commitSeq, 1);

    const partialBase = JSON.parse(JSON.stringify(first.state));
    partialBase.compressionBlockSourceLinks = [];
    partialBase.compressionContextVariants = [];
    partialBase.compressionBlockLlmInvocationLinks = [];
    partialBase.llmInvocations = [];
    const partialNext = JSON.parse(JSON.stringify(partialBase));
    partialNext.compressionBlocks[0].summaryPreview = 'v2';
    partialNext.compressionBlocks[0].updatedAt = 2;

    const compressionSaveEntered = deferred();
    releaseCompressionSave = deferred();
    let shouldBlockCompressionSave = true;
    compressionStore.__compressionStoreTestHooks.afterGenerationStorePrepare = async ({ conversationId: id, store }) => {
      if (!shouldBlockCompressionSave || id !== conversationId || store !== 'blocks') return;
      shouldBlockCompressionSave = false;
      compressionSaveEntered.resolve();
      await releaseCompressionSave.promise;
    };

    const secondPromise = clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      partialBase,
      partialNext
    );
    await compressionSaveEntered.promise;
    let concurrentPageResolved = false;
    const concurrentPagePromise = clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1
    }).then((page) => {
      concurrentPageResolved = true;
      return page;
    });
    await delay(30);
    assert.equal(concurrentPageResolved, false, 'page reader 必须等待 timeline+compression 统一提交完成');
    releaseCompressionSave.resolve();
    const [second, secondPage] = await Promise.all([secondPromise, concurrentPagePromise]);
    assert.equal(second.commitSeq, 2);
    assert.deepEqual(second.state.compressionBlockSourceLinks.map((record) => record.id), ['compression-source-canonical']);
    assert.deepEqual(second.state.compressionContextVariants.map((record) => record.id), ['compression-variant-canonical']);
    assert.deepEqual(second.state.compressionBlockLlmInvocationLinks.map((record) => record.id), ['compression-invocation-link-canonical']);
    assert.deepEqual(second.state.llmInvocations.map((record) => record.id), ['compression-invocation-canonical']);

    const patches = createPersistedConversationTimelineClientPatches(first.state, second.state);
    assert.equal(patches.some((patch) => patch.kind.endsWith('.remove')), false);
    assert.deepEqual(patches.map((patch) => patch.kind), ['compressionBlock.upsert']);
    assert.equal(secondPage.commitSeq, 2);
    assert.equal(secondPage.state.compressionBlocks[0].summaryPreview, 'v2');
    assert.ok(firstPage.commitSeq < secondPage.commitSeq, '旧 page 可由统一 commitSeq 明确判定为 stale');
  } finally {
    releaseCompressionSave?.resolve();
    compressionStore.__compressionStoreTestHooks.afterGenerationStorePrepare = undefined;
    await removeTempRoot(tempRoot);
  }
});

test('子快照或根指针失败时保持上一组 committed pair，不复用 commitSeq 标记混合快照', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-pair-atomic-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-timeline-pair-atomic';
  try {
    const initial = makeTimelineState(createEmptyClientState, conversationId, 1);
    initial.compressionBlocks.push({
      id: 'compression-pair-atomic',
      conversationId,
      title: 'pair atomic',
      status: 'complete',
      methodKind: 'llm_summary',
      anchorMessageId: initial.messages[0].id,
      anchorSeq: 1,
      endSeq: 1,
      summaryPreview: 'v1',
      createdAt: 1,
      updatedAt: 1
    });
    const first = await clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      createEmptyClientState(),
      initial
    );
    assert.equal(first.commitSeq, 1);

    const next = JSON.parse(JSON.stringify(first.state));
    next.messages.push(textMessage(conversationId, 'm-2', 2, 'message 2', 'model'));
    next.compressionBlocks[0].summaryPreview = 'v2';
    next.compressionBlocks[0].updatedAt = 2;

    let failedCompressionGeneration = false;
    compressionStore.__compressionStoreTestHooks.afterGenerationStorePrepare = ({ conversationId: id, store }) => {
      if (id !== conversationId || store !== 'blocks' || failedCompressionGeneration) return;
      failedCompressionGeneration = true;
      throw new Error('synthetic compression generation failure');
    };
    await assert.rejects(
      clientStateStore.saveConversationRenderDetailToStores(paths, conversationId, first.state, next),
      /Failed to prepare complete conversation timeline snapshot pair/
    );
    compressionStore.__compressionStoreTestHooks.afterGenerationStorePrepare = undefined;

    let page = await clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    assert.equal(page.commitSeq, 1);
    assert.deepEqual(page.state.messages.map((message) => message.id), ['m-1']);
    assert.equal(page.state.compressionBlocks[0].summaryPreview, 'v1');

    let failedTimelineGeneration = false;
    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = ({ conversationId: id }) => {
      if (id !== conversationId || failedTimelineGeneration) return;
      failedTimelineGeneration = true;
      throw new Error('synthetic timeline generation failure');
    };
    await assert.rejects(
      clientStateStore.saveConversationRenderDetailToStores(paths, conversationId, first.state, next),
      /Failed to prepare complete conversation timeline snapshot pair/
    );
    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = undefined;

    page = await clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    assert.equal(page.commitSeq, 1);
    assert.deepEqual(page.state.messages.map((message) => message.id), ['m-1']);
    assert.equal(page.state.compressionBlocks[0].summaryPreview, 'v1');

    let failedRootCommit = false;
    timelineCommitStore.__conversationTimelineCommitTestHooks.beforeCommitWrite = (record) => {
      if (record.conversationId !== conversationId || failedRootCommit) return;
      failedRootCommit = true;
      throw new Error('synthetic root commit failure');
    };
    await assert.rejects(
      clientStateStore.saveConversationRenderDetailToStores(paths, conversationId, first.state, next),
      /synthetic root commit failure/
    );
    timelineCommitStore.__conversationTimelineCommitTestHooks.beforeCommitWrite = undefined;

    page = await clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    assert.equal(page.commitSeq, 1);
    assert.deepEqual(page.state.messages.map((message) => message.id), ['m-1']);
    assert.equal(page.state.compressionBlocks[0].summaryPreview, 'v1');

    const second = await clientStateStore.saveConversationRenderDetailToStores(paths, conversationId, first.state, next);
    assert.equal(second.commitSeq, 2, '失败的准备/根发布不能消耗或复用可见 commitSeq');
    page = await clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    assert.equal(page.commitSeq, 2);
    assert.deepEqual(page.state.messages.map((message) => message.id), ['m-1', 'm-2']);
    assert.equal(page.state.compressionBlocks[0].summaryPreview, 'v2');
  } finally {
    compressionStore.__compressionStoreTestHooks.afterGenerationStorePrepare = undefined;
    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = undefined;
    timelineCommitStore.__conversationTimelineCommitTestHooks.beforeCommitWrite = undefined;
    await removeTempRoot(tempRoot);
  }
});

test('延迟的旧 cleanup 会在根锁内重读最新 refs，不删除当前 pair 或 tail prefix generation', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-cleanup-race-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-timeline-cleanup-race';
  const entered = [deferred(), deferred(), deferred()];
  const release = [deferred(), deferred(), deferred()];
  let cleanupIndex = 0;
  try {
    clientStateStore.__conversationTimelineGenerationCleanupTestHooks.beforeCleanup = async ({ conversationId: id }) => {
      if (id !== conversationId) return;
      const index = cleanupIndex++;
      if (!entered[index] || !release[index]) return;
      entered[index].resolve();
      await release[index].promise;
    };

    const firstState = makeTimelineState(createEmptyClientState, conversationId, 101);
    firstState.compressionBlocks.push({
      id: 'compression-cleanup-race',
      conversationId,
      title: 'cleanup race',
      status: 'complete',
      methodKind: 'llm_summary',
      anchorMessageId: firstState.messages[0].id,
      anchorSeq: 1,
      endSeq: 100,
      summaryPreview: 'v1',
      createdAt: 1,
      updatedAt: 1
    });
    const firstPromise = clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      createEmptyClientState(),
      firstState
    );
    await entered[0].promise;

    const secondState = JSON.parse(JSON.stringify(firstState));
    secondState.messages.push(textMessage(conversationId, 'm-102', 102, 'message 102', 'model'));
    secondState.compressionBlocks[0].summaryPreview = 'v2';
    secondState.compressionBlocks[0].updatedAt = 2;
    const secondPromise = clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      firstState,
      secondState
    );
    await entered[1].promise;

    const thirdState = JSON.parse(JSON.stringify(secondState));
    thirdState.messages.push(textMessage(conversationId, 'm-103', 103, 'message 103', 'user'));
    thirdState.compressionBlocks[0].summaryPreview = 'v3';
    thirdState.compressionBlocks[0].updatedAt = 3;
    const thirdPromise = clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      secondState,
      thirdState
    );
    await entered[2].promise;

    // A 的 cleanup 此时最陈旧；它必须重新获取根锁并读取 seq=3 refs，而不是按 seq=1 清理。
    release[0].resolve();
    const first = await firstPromise;
    assert.equal(first.commitSeq, 1);

    let page = await clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 2
    });
    assert.equal(page.commitSeq, 3);
    assert.equal(page.state.messages.length, 103);
    assert.equal(page.state.compressionBlocks[0].summaryPreview, 'v3');

    release[1].resolve();
    release[2].resolve();
    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    assert.equal(second.commitSeq, 2);
    assert.equal(third.commitSeq, 3);

    const detail = await clientStateStore.loadConversationDetailFromStores(paths, conversationId);
    assert.ok(detail);
    assert.equal(detail.messages.length, 103);
    assert.equal(detail.compressionBlocks[0].summaryPreview, 'v3');
    page = await clientStateStore.loadConversationTimelinePageFromStores(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 2
    });
    assert.equal(page.commitSeq, 3);
  } finally {
    clientStateStore.__conversationTimelineGenerationCleanupTestHooks.beforeCleanup = undefined;
    for (const gate of release) gate.resolve();
    await removeTempRoot(tempRoot);
  }
});

test('pending checkpoint sidecar 不会进入虚假 base，完成后可完整落盘并继续更新', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-pending-checkpoint-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-pending-checkpoint';
  try {
    const pending = makeTimelineState(createEmptyClientState, conversationId, 1);
    const ids = addCheckpointGraph(pending, conversationId, { status: 'pending' });
    const pendingProjection = clientStateStore.conversationRenderDetailSlice(pending, conversationId);

    assert.equal(pendingProjection.messages.length, 1);
    assert.equal(pendingProjection.checkpoints.length, 0);
    assert.equal(pendingProjection.projectContexts.length, 0);
    assert.equal(pendingProjection.shadowRepositories.length, 0);
    assert.equal(pendingProjection.conversationCheckpointRepositoryLinks.length, 0);

    const acknowledgedPending = await clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      createEmptyClientState(),
      pending
    );
    assert.deepEqual(acknowledgedPending.state, pendingProjection);
    assert.equal(acknowledgedPending.commitSeq, 1);
    const storedPending = await clientStateStore.loadConversationDetailFromStores(paths, conversationId);
    assert.equal(storedPending.messages.length, 1);
    assert.equal(storedPending.checkpoints.length, 0);
    assert.equal(storedPending.shadowRepositories.length, 0);

    const completed = JSON.parse(JSON.stringify(pending));
    completed.checkpoints[0].status = 'created';
    completed.checkpoints[0].updatedAt = 20;
    completed.checkpointTimelineAnchors.push({
      id: `checkpoint-anchor-${conversationId}-1`,
      conversationId,
      checkpointId: ids.checkpointId,
      floorMessageId: completed.messages[0].id,
      position: 'before',
      order: 1,
      createdAt: 20,
      updatedAt: 20
    });
    const acknowledgedCompleted = await clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      pendingProjection,
      completed
    );

    const completedProjection = clientStateStore.conversationRenderDetailSlice(completed, conversationId);
    assert.deepEqual(acknowledgedCompleted.state, completedProjection);
    assert.equal(acknowledgedCompleted.commitSeq, 2);
    const storedCompleted = await clientStateStore.loadConversationDetailFromStores(paths, conversationId);
    assert.equal(storedCompleted.checkpoints.length, 1);
    assert.equal(storedCompleted.checkpointTimelineAnchors.length, 1);
    assert.deepEqual(storedCompleted.projectContexts.map((record) => record.id), [ids.projectContextId]);
    assert.deepEqual(storedCompleted.shadowRepositories.map((record) => record.id), [ids.shadowRepositoryId]);
    assert.deepEqual(storedCompleted.conversationCheckpointRepositoryLinks.map((record) => record.id), [ids.linkId]);

    const nextCheckpoint = JSON.parse(JSON.stringify(completed));
    nextCheckpoint.shadowRepositories[0].updatedAt = 30;
    nextCheckpoint.conversationCheckpointRepositoryLinks[0].updatedAt = 30;
    addCheckpointGraph(nextCheckpoint, conversationId, {
      suffix: '2',
      status: 'pending',
      projectContextId: ids.projectContextId,
      shadowRepositoryId: ids.shadowRepositoryId,
      linkId: ids.linkId,
      createdAt: 30,
      updatedAt: 30
    });
    const acknowledgedNext = await clientStateStore.saveConversationRenderDetailToStores(
      paths,
      conversationId,
      completedProjection,
      nextCheckpoint
    );
    assert.deepEqual(
      acknowledgedNext.state,
      clientStateStore.conversationRenderDetailSlice(nextCheckpoint, conversationId)
    );
    assert.equal(acknowledgedNext.commitSeq, 3);

    const storedNext = await clientStateStore.loadConversationDetailFromStores(paths, conversationId);
    assert.equal(storedNext.checkpoints.length, 1);
    assert.equal(storedNext.shadowRepositories[0].updatedAt, 30);
    assert.equal(storedNext.conversationCheckpointRepositoryLinks[0].updatedAt, 30);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('跨 chunk checkpoint 共享 sidecar 时完整读取保持 record id 唯一', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-shared-sidecar-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-shared-sidecar';
  try {
    const state = makeTimelineState(createEmptyClientState, conversationId, 201);
    const ids = addCheckpointGraph(state, conversationId, {
      suffix: 'first',
      status: 'created',
      floorMessageId: 'm-50',
      order: 1
    });
    addCheckpointGraph(state, conversationId, {
      suffix: 'second',
      status: 'created',
      floorMessageId: 'm-150',
      order: 2,
      projectContextId: ids.projectContextId,
      shadowRepositoryId: ids.shadowRepositoryId,
      linkId: ids.linkId
    });

    await timelineStore.saveConversationTimelineDetail(paths, conversationId, state);
    const stored = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(stored.checkpoints.length, 2);
    assert.deepEqual(stored.projectContexts.map((record) => record.id), [ids.projectContextId]);
    assert.deepEqual(stored.shadowRepositories.map((record) => record.id), [ids.shadowRepositoryId]);
    assert.deepEqual(stored.conversationCheckpointRepositoryLinks.map((record) => record.id), [ids.linkId]);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('无关 conversation 的重复 skeleton relation 不阻塞目标 conversation timeline 保存', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-scope-isolation-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-scope-isolation-target';
  try {
    const base = createEmptyClientState();
    const next = makeTimelineState(createEmptyClientState, conversationId, 1);
    const duplicateId = 'conversation-agent:conv-unrelated:agent-reviewer-mirror';
    next.conversationAgentSelections = [
      {
        id: duplicateId,
        conversationId: 'conv-unrelated',
        agentId: 'agent-reviewer-mirror',
        role: 'active',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: duplicateId,
        conversationId: 'conv-unrelated',
        agentId: 'agent-reviewer-mirror',
        role: 'active',
        createdAt: 1,
        updatedAt: 2
      }
    ];

    await clientStateStore.saveConversationRenderDetailToStores(paths, conversationId, base, next);

    const saved = await clientStateStore.loadConversationDetailFromStores(paths, conversationId);
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0].conversationId, conversationId);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('timeline full publish 失败时旧 generation 仍完整可读', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-publish-fail-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-publish-fail';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 2));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));

    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = async () => {
      throw new Error('simulated timeline index publish failure');
    };
    await assert.rejects(
      timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 3)),
      /simulated timeline index publish failure/
    );
    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = undefined;

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(afterIndex.generation, beforeIndex.generation);
    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.messages.length, 2);
  } finally {
    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = undefined;
    await removeTempRoot(tempRoot);
  }
});

test('indexed chunk/sidecar 损坏会阻止后续写入，不能用 partial timeline 覆盖', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-corrupt-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    const chunkConversationId = 'conv-corrupt-chunk';
    await timelineStore.saveConversationTimelineDetail(paths, chunkConversationId, makeTimelineState(createEmptyClientState, chunkConversationId, 3));
    const chunkRoot = timelineRoot(paths, chunkConversationId);
    const chunkIndex = await readJsonFile(path.join(chunkRoot, 'index.json'));
    await fs.writeFile(path.join(chunkRoot, chunkIndex.chunks[0].file), '{bad-json', 'utf8');

    await assert.rejects(
      timelineStore.saveConversationTimelineDetail(paths, chunkConversationId, makeTimelineState(createEmptyClientState, chunkConversationId, 4)),
      /chunk JSON is invalid|Failed to read|hash/i
    );
    const afterChunkIndex = await readJsonFile(path.join(chunkRoot, 'index.json'));
    assert.equal(afterChunkIndex.generation, chunkIndex.generation);

    const sidecarConversationId = 'conv-corrupt-sidecar';
    await timelineStore.saveConversationTimelineDetail(paths, sidecarConversationId, makeTimelineState(createEmptyClientState, sidecarConversationId, 3));
    const sidecarRoot = timelineRoot(paths, sidecarConversationId);
    const sidecarIndex = await readJsonFile(path.join(sidecarRoot, 'index.json'));
    await fs.writeFile(path.join(sidecarRoot, sidecarIndex.chunks[0].sidecars['tool-calls'].file), '{bad-json', 'utf8');

    await assert.rejects(
      timelineStore.saveConversationTimelineDetail(paths, sidecarConversationId, makeTimelineState(createEmptyClientState, sidecarConversationId, 4)),
      /sidecar JSON is invalid|Failed to read|hash/i
    );
    const afterSidecarIndex = await readJsonFile(path.join(sidecarRoot, 'index.json'));
    assert.equal(afterSidecarIndex.generation, sidecarIndex.generation);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('incremental 严格合并后 projection context 仍可读', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-projection-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-projection';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 2, { withTaskListToolCall: true }));
    const patch = createEmptyClientState();
    patch.messages.push(textMessage(conversationId, 'm-3', 3, 'new tail', 'model'));
    const saved = await commitTimelinePatch(paths, conversationId, patch);
    assert.equal(saved, true);

    const page = await timelineStore.loadConversationTimelinePage(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1,
      includeProjections: ['task-list']
    });
    assert.equal(page.state.messages.length, 3);
    assert.ok(page.projections && page.projections['task-list']);
    assert.equal(page.projections['task-list'].latestChunkId, page.chunks[page.chunks.length - 1].id);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('并发 message writers 通过 timeline root lock 合并且不丢消息', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-concurrent-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-concurrent';
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const seq = index + 1;
      return clientStateStore.saveMessageRecord(paths, conversationId, textMessage(conversationId, `m-${seq}`, seq, `message ${seq}`));
    }));
    const detail = await clientStateStore.loadConversationDetailFromStores(paths, conversationId);
    assert.equal(detail.messages.length, 12);
    assert.deepEqual(detail.messages.map((message) => message.id).sort(), Array.from({ length: 12 }, (_, index) => `m-${index + 1}`).sort());
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('reader 发现 generation 变化会有限重试并读取新 manifest', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-reader-retry-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-reader-retry';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 1));
    let switched = false;
    timelineStore.__conversationTimelineStoreTestHooks.afterReadIndexBeforeFiles = async ({ attempt }) => {
      if (attempt !== 1 || switched) return;
      switched = true;
      await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 2));
    };

    const page = await timelineStore.loadConversationTimelinePage(paths, { conversationId, direction: 'initial', chunkCount: 1 });
    assert.equal(page.state.messages.length, 2);
    assert.equal(switched, true);
  } finally {
    timelineStore.__conversationTimelineStoreTestHooks.afterReadIndexBeforeFiles = undefined;
    await removeTempRoot(tempRoot);
  }
});

test('loadConversationTimelineDetail 缺失 index 且无 traces 返回 undefined，损坏 index 或 indexed 文件抛错', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-detail-errors-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  try {
    assert.equal(await timelineStore.loadConversationTimelineDetail(paths, 'conv-missing-clean'), undefined);

    const invalidIndexConversationId = 'conv-invalid-index';
    const invalidIndexRoot = timelineRoot(paths, invalidIndexConversationId);
    await fs.mkdir(invalidIndexRoot, { recursive: true });
    await fs.writeFile(path.join(invalidIndexRoot, 'index.json'), '{bad-json', 'utf8');
    await assert.rejects(
      timelineStore.loadConversationTimelineDetail(paths, invalidIndexConversationId),
      /timeline index JSON is invalid|Unexpected/i
    );

    const missingIndexedFileConversationId = 'conv-missing-indexed-file';
    await timelineStore.saveConversationTimelineDetail(paths, missingIndexedFileConversationId, makeTimelineState(createEmptyClientState, missingIndexedFileConversationId, 1));
    const indexedRoot = timelineRoot(paths, missingIndexedFileConversationId);
    const index = await readJsonFile(path.join(indexedRoot, 'index.json'));
    await fs.rm(path.join(indexedRoot, index.chunks[0].file));
    await assert.rejects(
      timelineStore.loadConversationTimelineDetail(paths, missingIndexedFileConversationId),
      /Indexed conversation timeline chunk is missing|chunk is missing|Failed to load conversation timeline detail/i
    );
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('loadConversationDetailFromStores 返回合法空 detail 而不是把存在的空 timeline 当缺失', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-conversation-empty-detail-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-empty-detail';
  try {
    await clientStateStore.saveConversationTimelineRenderDetailToStores(
      paths,
      conversationId,
      createEmptyClientState(),
      createEmptyClientState()
    );
    const detail = await clientStateStore.loadConversationDetailFromStores(paths, conversationId);
    assert.ok(detail);
    assert.equal(detail.messages.length, 0);
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('truncate 发布新 generation 且不原地覆盖旧 chunk', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-truncate-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-truncate';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 3));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    const oldChunkPath = path.join(root, beforeIndex.chunks[0].file);

    const result = await timelineStore.truncateConversationTimeline(paths, {
      conversationId,
      anchorMessageId: 'm-2',
      keepAnchor: true
    });
    assert.deepEqual(result.removedMessageIds, ['m-3']);

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.notEqual(afterIndex.generation, beforeIndex.generation);
    assert.notEqual(afterIndex.chunks[0].file, beforeIndex.chunks[0].file);
    await fs.access(oldChunkPath);
    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.deepEqual(detail.messages.map((message) => message.id), ['m-1', 'm-2']);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('truncate 只重写锚点 chunk 并复用未受影响前缀', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-truncate-incremental-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-truncate-incremental';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 250, { withTaskListToolCall: true }));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(beforeIndex.chunks.length, 3);
    const beforePrefixChunk = beforeIndex.chunks[0];
    const beforePrefixInfo = await collectChunkRefInfo(root, [beforePrefixChunk]);
    const beforeAnchorChunk = beforeIndex.chunks[1];

    const result = await timelineStore.truncateConversationTimeline(paths, {
      conversationId,
      anchorMessageId: 'm-150',
      keepAnchor: true
    });
    assert.equal(result.removedMessageIds.length, 100);
    assert.equal(result.removedMessageIds[0], 'm-151');
    assert.equal(result.removedMessageIds.at(-1), 'm-250');

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.notEqual(afterIndex.generation, beforeIndex.generation);
    assert.equal(afterIndex.chunks.length, 2);
    assert.deepEqual(afterIndex.chunks[0], beforePrefixChunk);
    assert.notEqual(afterIndex.chunks[1].file, beforeAnchorChunk.file);
    assert.equal(afterIndex.chunks[1].generation, afterIndex.generation);
    assert.equal(afterIndex.chunks[1].messageIds.length, 50);
    assert.equal(afterIndex.chunks[1].messageIds.at(-1), 'm-150');
    assert.deepEqual(await collectChunkRefInfo(root, [afterIndex.chunks[0]]), beforePrefixInfo);

    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.messages.length, 150);
    assert.equal(detail.messages.at(-1).id, 'm-150');
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('truncate 落在 chunk 边界时只发布新 index 并复用全部保留 chunk', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-truncate-boundary-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-truncate-boundary';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 250));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));

    const result = await timelineStore.truncateConversationTimeline(paths, {
      conversationId,
      anchorMessageId: 'm-201',
      keepAnchor: false
    });
    assert.equal(result.removedMessageIds.length, 50);

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.notEqual(afterIndex.generation, beforeIndex.generation);
    assert.deepEqual(afterIndex.chunks, beforeIndex.chunks.slice(0, 2));
    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.messages.length, 200);
    assert.equal(detail.messages.at(-1).id, 'm-200');
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('tail incremental 只重写受影响 suffix 并复用 prefix generation/projection', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-tail-incremental-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-tail-incremental';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 250, { withTaskListToolCall: true }));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(beforeIndex.chunks.length, 3);
    const beforePrefixChunks = beforeIndex.chunks.slice(0, 2);
    const beforePrefixInfo = await collectChunkRefInfo(root, beforePrefixChunks);
    const beforeTailChunk = beforeIndex.chunks[2];

    const patch = createEmptyClientState();
    patch.messages.push(textMessage(conversationId, 'm-250', 250, 'updated streamed tail', 'model'));
    patch.messages.push(textMessage(conversationId, 'm-251', 251, 'new tail message', 'model'));
    const saved = await commitTimelinePatch(paths, conversationId, patch);
    assert.equal(saved, true);

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.notEqual(afterIndex.generation, beforeIndex.generation);
    assert.equal(afterIndex.chunks.length, 3);
    assert.deepEqual(afterIndex.chunks.slice(0, 2), beforePrefixChunks);
    assert.notEqual(afterIndex.chunks[2].file, beforeTailChunk.file);
    assert.equal(afterIndex.chunks[2].generation, afterIndex.generation);

    const afterPrefixInfo = await collectChunkRefInfo(root, afterIndex.chunks.slice(0, 2));
    assert.deepEqual(afterPrefixInfo, beforePrefixInfo);

    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.messages.length, 251);
    assert.equal(detail.messages.find((message) => message.id === 'm-250').content.parts[0].text, 'updated streamed tail');
    assert.equal(detail.messages.find((message) => message.id === 'm-251').content.parts[0].text, 'new tail message');

    const page = await timelineStore.loadConversationTimelinePage(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 1,
      includeProjections: ['task-list']
    });
    const projection = page.projections && page.projections['task-list'];
    assert.ok(projection);
    assert.equal(projection.latestChunkId, afterIndex.chunks[2].id);
    assert.ok(projection.latestSnapshot.items.some((item) => item.title === '梳理实现'));
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('跨 chunk 尾部发布遇到 Canceled 时旧 active index 仍保留完整历史', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-tail-cancelled-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-tail-cancelled';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 100));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(beforeIndex.chunks.length, 1);

    const patch = createEmptyClientState();
    patch.messages.push(textMessage(conversationId, 'm-101', 101, 'new tail 101', 'user'));
    patch.messages.push(textMessage(conversationId, 'm-102', 102, 'new tail 102', 'model'));
    patch.messages.push(textMessage(conversationId, 'm-103', 103, 'new tail 103', 'user'));

    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = async () => {
      throw new Error('Canceled');
    };
    await assert.rejects(
      commitTimelinePatch(paths, conversationId, patch),
      /Canceled/
    );
    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = undefined;

    const afterFailureIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(afterFailureIndex.generation, beforeIndex.generation);
    const afterFailureDetail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(afterFailureDetail.messages.length, 100);
    assert.equal(afterFailureDetail.messages.at(-1).id, 'm-100');

    await commitTimelinePatch(paths, conversationId, patch);
    const committedIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(committedIndex.chunks.length, 2);
    assert.deepEqual(committedIndex.chunks[0].messageIds, beforeIndex.chunks[0].messageIds);
    const committedDetail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(committedDetail.messages.length, 103);
    assert.equal(committedDetail.messages.at(-1).id, 'm-103');
  } finally {
    timelineStore.__conversationTimelineStoreTestHooks.beforePublishIndex = undefined;
    await removeTempRoot(tempRoot);
  }
});

test('merge active index 只剩最新 chunk 时会用 previous index 恢复旧前缀', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-previous-recovery-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-previous-recovery';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 100));
    const root = timelineRoot(paths, conversationId);
    const previousCommitted = await readJsonFile(path.join(root, 'index.json'));

    const patch = createEmptyClientState();
    patch.messages.push(textMessage(conversationId, 'm-101', 101, 'new tail 101', 'user'));
    patch.messages.push(textMessage(conversationId, 'm-102', 102, 'new tail 102', 'model'));
    patch.messages.push(textMessage(conversationId, 'm-103', 103, 'new tail 103', 'user'));
    await commitTimelinePatch(paths, conversationId, patch);

    const active = await readJsonFile(path.join(root, 'index.json'));
    const previous = await readJsonFile(path.join(root, 'index.previous.json'));
    assert.equal(active.operation, 'merge');
    assert.equal(active.parentGeneration, previousCommitted.generation);
    assert.equal(previous.generation, previousCommitted.generation);
    assert.equal(active.chunks.length, 2);

    // 模拟用户反馈中的形态：根 active index 仍是合法 JSON，但只挂载最新 generation 的 3 条消息。
    const tail = active.chunks[1];
    const regressed = {
      ...active,
      chunks: [{
        ...tail,
        index: 0,
        messageOffsetStart: 1,
        messageOffsetEnd: tail.messageCount
      }]
    };
    await fs.writeFile(path.join(root, 'index.json'), `${JSON.stringify(regressed, null, 2)}\n`, 'utf8');

    const recovered = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(recovered.messages.length, 103);
    assert.equal(recovered.messages[0].id, 'm-1');
    assert.equal(recovered.messages.at(-1).id, 'm-103');

    const page = await timelineStore.loadConversationTimelinePage(paths, {
      conversationId,
      direction: 'initial',
      chunkCount: 2,
      includeProjections: ['task-list']
    });
    assert.ok(page.projections && page.projections['task-list']);
    assert.equal(page.pageInfo.totalChunks, 2);
    assert.equal(page.pageInfo.totalMessages, 103);
    assert.equal(page.state.messages.length, 103);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('tail incremental 会校验并忽略未变化的只读 context prefix', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-tail-context-prefix-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-tail-context-prefix';
  try {
    const initial = makeTimelineState(createEmptyClientState, conversationId, 250);
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, initial);
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    const beforePrefixChunks = beforeIndex.chunks.slice(0, 2);

    const patch = createEmptyClientState();
    const contextPrefixMessage = initial.messages.find((message) => message.id === 'm-150');
    assert.ok(contextPrefixMessage);
    patch.messages.push(contextPrefixMessage);
    patch.messages.push(textMessage(conversationId, 'm-250', 250, 'updated streamed tail', 'model'));
    patch.messages.push(textMessage(conversationId, 'm-251', 251, 'new tail message', 'user'));
    const saved = await commitTimelinePatch(paths, conversationId, patch);
    assert.equal(saved, true);

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.deepEqual(afterIndex.chunks.slice(0, 2), beforePrefixChunks);
    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.messages.length, 251);
    assert.equal(detail.messages.find((message) => message.id === 'm-150').content.parts[0].text, 'message 150');
    assert.equal(detail.messages.find((message) => message.id === 'm-250').content.parts[0].text, 'updated streamed tail');
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('tail incremental 按 JSON 落盘语义忽略 prefix ToolCall 的 undefined 字段', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-tail-json-equivalent-prefix-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-tail-json-equivalent-prefix';
  try {
    const initial = makeTimelineState(createEmptyClientState, conversationId, 250);
    const prefixMessage = initial.messages.find((message) => message.id === 'm-150');
    assert.ok(prefixMessage);
    const prefixToolCall = tailToolCall(prefixMessage, 'tool-prefix-json-equivalent');
    prefixToolCall.result = {
      parts: [{ inlineData: { mimeType: 'image/png', name: 'result.png', data: undefined } }]
    };
    initial.toolCalls.push(prefixToolCall);
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, initial);

    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    const beforePrefixChunks = beforeIndex.chunks.slice(0, 2);
    const storedBefore = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    const storedInlineData = storedBefore.toolCalls[0].result.parts[0].inlineData;
    assert.equal(Object.prototype.hasOwnProperty.call(storedInlineData, 'data'), false);

    const patch = createEmptyClientState();
    patch.messages.push(prefixMessage);
    patch.toolCalls.push(prefixToolCall);
    patch.messages.push(textMessage(conversationId, 'm-250', 250, 'updated streamed tail', 'model'));
    patch.messages.push(textMessage(conversationId, 'm-251', 251, 'new tail message', 'user'));
    const saved = await commitTimelinePatch(paths, conversationId, patch);
    assert.equal(saved, true);

    const afterEquivalentIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.deepEqual(afterEquivalentIndex.chunks.slice(0, 2), beforePrefixChunks);

    const changedPatch = createEmptyClientState();
    changedPatch.toolCalls.push({ ...prefixToolCall, status: 'warning', error: 'real persisted change' });
    const changedSaved = await commitTimelinePatch(paths, conversationId, changedPatch);
    assert.equal(changedSaved, true);

    const afterChangedIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.notDeepEqual(afterChangedIndex.chunks.slice(0, 2), afterEquivalentIndex.chunks.slice(0, 2));
    const storedAfter = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    const changedToolCall = storedAfter.toolCalls.find((toolCall) => toolCall.id === prefixToolCall.id);
    assert.equal(changedToolCall.status, 'warning');
    assert.equal(changedToolCall.error, 'real persisted change');
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('tail incremental 不再跳过仅 tool event patch', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-tail-event-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-tail-event';
  try {
    const state = makeTimelineState(createEmptyClientState, conversationId, 250);
    state.toolCalls.push(tailToolCall(state.messages[state.messages.length - 1]));
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, state);

    const patch = createEmptyClientState();
    patch.toolCallEvents.push({
      id: 'tail-event-1',
      toolCallId: 'tool-tail-1',
      seq: 1,
      kind: 'stdout',
      at: Date.now(),
      delta: 'tail event persisted'
    });
    const saved = await commitTimelinePatch(paths, conversationId, patch);
    assert.equal(saved, true);

    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.toolCallEvents.length, 1);
    assert.equal(detail.toolCallEvents[0].delta, 'tail event persisted');
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('修改早期 message 会 fallback full rewrite 而不是复用 prefix', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-early-full-rewrite-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-early-full-rewrite';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 250));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(beforeIndex.chunks.length, 3);

    const patch = createEmptyClientState();
    patch.messages.push(textMessage(conversationId, 'm-1', 1, 'early edit', 'user'));
    const saved = await commitTimelinePatch(paths, conversationId, patch);
    assert.equal(saved, true);

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.notEqual(afterIndex.generation, beforeIndex.generation);
    assert.equal(afterIndex.chunks.length, 3);
    assert.ok(afterIndex.chunks.every((chunk) => chunk.generation === afterIndex.generation));
    assert.notEqual(afterIndex.chunks[0].file, beforeIndex.chunks[0].file);
    assert.notEqual(afterIndex.chunks[1].file, beforeIndex.chunks[1].file);

    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.messages.find((message) => message.id === 'm-1').content.parts[0].text, 'early edit');
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('tail incremental 受影响 suffix projection 损坏会阻止写入', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-tail-corrupt-suffix-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-tail-corrupt-suffix';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 250, { withTaskListToolCall: true }));
    const root = timelineRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));
    const tailProjectionFile = Object.values(beforeIndex.chunks[2].projections)[0].file;
    await fs.writeFile(path.join(root, tailProjectionFile), '{bad-json', 'utf8');

    const patch = createEmptyClientState();
    patch.messages.push(textMessage(conversationId, 'm-251', 251, 'blocked by corrupt suffix', 'model'));
    await assert.rejects(
      commitTimelinePatch(paths, conversationId, patch),
      /projection JSON is invalid|Failed to read|hash|Unexpected/i
    );

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(afterIndex.generation, beforeIndex.generation);
    assert.equal(afterIndex.chunks.length, beforeIndex.chunks.length);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('并发 tail incremental writers 不丢消息', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-tail-concurrent-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-tail-concurrent';
  try {
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, makeTimelineState(createEmptyClientState, conversationId, 250));
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const seq = 251 + index;
      const patch = createEmptyClientState();
      patch.messages.push(textMessage(conversationId, `m-${seq}`, seq, `concurrent tail ${seq}`, seq % 2 ? 'user' : 'model'));
      return commitTimelinePatch(paths, conversationId, patch);
    }));

    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(detail.messages.length, 262);
    for (let seq = 251; seq <= 262; seq += 1) {
      assert.ok(detail.messages.some((message) => message.id === `m-${seq}`), `missing m-${seq}`);
    }
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('陈旧窗口只追加新消息时，不会把同 id 已完成流式消息回退为旧内容', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-stale-stream-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-stale-stream';
  try {
    const initial = createEmptyClientState();
    const streaming = textMessage(conversationId, 'stream-1', 1, 'OLD PARTIAL CONTENT', 'model');
    streaming.status = 'streaming';
    initial.messages.push(streaming);
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, initial);

    const baseA = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    const baseB = JSON.parse(JSON.stringify(baseA));

    const nextA = JSON.parse(JSON.stringify(baseA));
    nextA.messages[0].content.parts[0].text = 'NEW FINAL CONTENT';
    nextA.messages[0].status = 'complete';
    await timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, baseA, nextA);

    const nextB = JSON.parse(JSON.stringify(baseB));
    nextB.messages.push(textMessage(conversationId, 'message-from-stale-window', 2, 'independent append'));
    await timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, baseB, nextB);

    const stored = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(stored.messages.length, 2);
    assert.equal(stored.messages.find((message) => message.id === 'stream-1').content.parts[0].text, 'NEW FINAL CONTENT');
    assert.equal(stored.messages.find((message) => message.id === 'stream-1').status, 'complete');
    assert.ok(stored.messages.some((message) => message.id === 'message-from-stale-window'));
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('陈旧窗口保存旧 streaming 片段时不应和已完成消息冲突或回退内容', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-stale-stream-flush-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-stale-stream-flush';
  try {
    const initial = createEmptyClientState();
    const streaming = textMessage(conversationId, 'stream-flush-1', 1, 'partial', 'model');
    streaming.status = 'streaming';
    initial.messages.push(streaming);
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, initial);

    const baseA = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    const baseB = JSON.parse(JSON.stringify(baseA));

    const nextA = JSON.parse(JSON.stringify(baseA));
    nextA.messages[0].content.parts[0].text = 'final answer from active writer';
    nextA.messages[0].status = 'complete';
    await timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, baseA, nextA);

    const nextB = JSON.parse(JSON.stringify(baseB));
    nextB.messages[0].content.parts[0].text = 'stale partial from delayed flush';
    nextB.messages[0].status = 'streaming';
    const acknowledged = await timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, baseB, nextB);

    assert.equal(acknowledged.messages.length, 1);
    assert.equal(acknowledged.messages[0].content.parts[0].text, 'final answer from active writer');
    assert.equal(acknowledged.messages[0].status, 'complete');
    const stored = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.messages[0].content.parts[0].text, 'final answer from active writer');
    assert.equal(stored.messages[0].status, 'complete');
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('陈旧 streaming 与新消息同批提交时只发布 accepted delta，ACK 可继续作为删除 base', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-stale-stream-with-append-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-stale-stream-with-append';
  try {
    const initial = createEmptyClientState();
    const streaming = textMessage(conversationId, 'stream-with-append-1', 1, 'partial', 'model');
    streaming.status = 'streaming';
    initial.messages.push(streaming);
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, initial);

    const baseA = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    const baseB = JSON.parse(JSON.stringify(baseA));
    const nextA = JSON.parse(JSON.stringify(baseA));
    nextA.messages[0].content.parts[0].text = 'canonical final answer';
    nextA.messages[0].status = 'complete';
    await timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, baseA, nextA);

    const nextB = JSON.parse(JSON.stringify(baseB));
    nextB.messages[0].content.parts[0].text = 'stale partial that must not be replayed';
    nextB.messages[0].status = 'streaming';
    nextB.messages.push(textMessage(conversationId, 'independent-append', 2, 'independent append'));
    const acknowledged = await timelineStore.commitConversationTimelineRenderDetail(
      paths,
      conversationId,
      baseB,
      nextB
    );

    assert.deepEqual(
      acknowledged.messages.map((message) => [message.id, message.content.parts[0].text, message.status]),
      [
        ['stream-with-append-1', 'canonical final answer', 'complete'],
        ['independent-append', 'independent append', 'complete']
      ]
    );
    const stored = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.deepEqual(
      stored.messages.map((message) => [message.id, message.content.parts[0].text, message.status]),
      [
        ['stream-with-append-1', 'canonical final answer', 'complete'],
        ['independent-append', 'independent append', 'complete']
      ]
    );

    const afterDelete = JSON.parse(JSON.stringify(acknowledged));
    afterDelete.messages = afterDelete.messages.filter((message) => message.id !== 'stream-with-append-1');
    await timelineStore.commitConversationTimelineRenderDetail(
      paths,
      conversationId,
      acknowledged,
      afterDelete
    );
    const storedAfterDelete = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.deepEqual(storedAfterDelete.messages.map((message) => message.id), ['independent-append']);
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('两个窗口真正修改同一 timeline record 时明确冲突，不静默覆盖', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-timeline-same-record-conflict-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-same-record-conflict';
  try {
    const initial = createEmptyClientState();
    initial.messages.push(textMessage(conversationId, 'shared-message', 1, 'original', 'model'));
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, initial);

    const baseA = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    const baseB = JSON.parse(JSON.stringify(baseA));
    const nextA = JSON.parse(JSON.stringify(baseA));
    const nextB = JSON.parse(JSON.stringify(baseB));
    nextA.messages[0].content.parts[0].text = 'writer A';
    nextB.messages[0].content.parts[0].text = 'writer B';

    await timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, baseA, nextA);
    await assert.rejects(
      timelineStore.commitConversationTimelineRenderDetail(paths, conversationId, baseB, nextB),
      /Conversation timeline conflict.*shared-message/
    );

    const stored = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
    assert.equal(stored.messages[0].content.parts[0].text, 'writer A');
  } finally {
    await removeTempRoot(tempRoot);
  }
});


test('收尾恢复 vscode mock', () => {
  restore();
});
