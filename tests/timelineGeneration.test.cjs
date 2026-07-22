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

const restore = installVscodeMock();
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const timelineStore = require('../dist/extension/backend/capabilities/vscodeStorage/conversationTimelineStore.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

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
    const saved = await timelineStore.saveConversationTimelineRenderDetailIncremental(paths, conversationId, patch);
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
    const detail = await timelineStore.loadConversationTimelineDetail(paths, conversationId);
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
    await timelineStore.saveConversationTimelineDetail(paths, conversationId, createEmptyClientState());
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
    const saved = await timelineStore.saveConversationTimelineRenderDetailIncremental(paths, conversationId, patch);
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
    const saved = await timelineStore.saveConversationTimelineRenderDetailIncremental(paths, conversationId, patch);
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
    const saved = await timelineStore.saveConversationTimelineRenderDetailIncremental(paths, conversationId, patch);
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
      timelineStore.saveConversationTimelineRenderDetailIncremental(paths, conversationId, patch),
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
      return timelineStore.saveConversationTimelineRenderDetailIncremental(paths, conversationId, patch);
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


test('收尾恢复 vscode mock', () => {
  restore();
});
