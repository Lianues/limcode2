const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { createPinia, setActivePinia } = require('pinia');

const root = path.resolve(__dirname, '..');

function loadConversationTimelineStoreModule() {
  global.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      return setTimeout(() => callback(performance.now()), 0);
    },
    cancelAnimationFrame(id) {
      clearTimeout(id);
    },
    setTimeout,
    clearTimeout
  };

  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'webview/src/stores/useConversationTimelineStore.ts')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    tsconfig: path.join(root, 'tsconfig.webview.json'),
    external: ['vue', 'pinia'],
    logLevel: 'silent'
  });

  const filename = path.join(root, '.test-conversation-timeline-store.cjs');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

const { useConversationTimelineStore } = loadConversationTimelineStoreModule();

function createStoreTimeline(conversationId = 'conversation-1') {
  setActivePinia(createPinia());
  const store = useConversationTimelineStore();
  return { store, timeline: store.ensureTimeline(conversationId), conversationId };
}

function message(id, conversationId, text) {
  return {
    id,
    conversationId,
    seq: 1,
    role: 'model',
    status: 'streaming',
    content: { parts: [{ text }] },
    createdAt: 1,
    updatedAt: 1
  };
}

function toolCall(id, messageId) {
  return {
    id,
    functionCallId: id,
    messageId,
    name: 'read',
    status: 'success',
    args: {},
    createdAt: 1,
    updatedAt: 1
  };
}

function toolEvent(id, toolCallId) {
  return {
    id,
    toolCallId,
    seq: 1,
    createdAt: 1
  };
}

test('timeline sidecar append 不会重复写入已有 stream materialized message', () => {
  const { store, timeline, conversationId } = createStoreTimeline();
  timeline.pageState.messages.push(message('message-1', conversationId, 'A'));
  timeline.streamState.messages.push(message('message-1', conversationId, 'AB'));
  timeline.state.messages.push(message('message-1', conversationId, 'AB'));
  const visibleMessage = timeline.state.messages[0];

  store.applyTimelinePatch({
    conversationId,
    commitSeq: 1,
    patches: [{ kind: 'message.partText.append', id: 'message-1', partIndex: 0, delta: 'B' }]
  });

  assert.equal(timeline.pageState.messages[0].content.parts[0].text, 'AB');
  assert.equal(timeline.streamState.messages[0].content.parts[0].text, 'AB');
  assert.equal(timeline.state.messages[0].content.parts[0].text, 'AB');
  assert.strictEqual(timeline.state.messages[0], visibleMessage);
});

test('无 stream 覆盖时 timeline patch 只重物化受影响记录', () => {
  const { store, timeline, conversationId } = createStoreTimeline();
  timeline.pageState.messages.push(message('message-1', conversationId, 'A'));
  timeline.state.messages.push(message('message-1', conversationId, 'A'));
  const previousVisibleMessage = timeline.state.messages[0];

  store.applyTimelinePatch({
    conversationId,
    commitSeq: 1,
    patches: [{ kind: 'message.partText.append', id: 'message-1', partIndex: 0, delta: 'B' }]
  });

  assert.equal(timeline.pageState.messages[0].content.parts[0].text, 'AB');
  assert.equal(timeline.state.messages[0].content.parts[0].text, 'AB');
  assert.notStrictEqual(timeline.state.messages[0], previousVisibleMessage);
});

test('稳定 mutation 不会把当前 materialized window 外的记录重新插入', () => {
  const { store, timeline, conversationId } = createStoreTimeline();
  timeline.pageState.messages.push(message('message-1', conversationId, 'A'));
  timeline.streamState.messages.push(message('message-1', conversationId, 'AB'));

  store.applyTimelinePatch({
    conversationId,
    commitSeq: 1,
    patches: [{ kind: 'message.partText.append', id: 'message-1', partIndex: 0, delta: 'B' }]
  });

  assert.equal(timeline.state.messages.length, 0);
});

test('page remove 不会删除仍由 stream 覆盖的 materialized record', () => {
  const { store, timeline, conversationId } = createStoreTimeline();
  timeline.pageState.messages.push(message('message-1', conversationId, 'page'));
  timeline.streamState.messages.push(message('message-1', conversationId, 'stream'));
  timeline.state.messages.push(message('message-1', conversationId, 'stream'));
  const visibleMessage = timeline.state.messages[0];

  store.applyTimelinePatch({
    conversationId,
    commitSeq: 1,
    patches: [{ kind: 'message.remove', id: 'message-1' }]
  });

  assert.equal(timeline.pageState.messages.length, 0);
  assert.equal(timeline.state.messages[0].content.parts[0].text, 'stream');
  assert.strictEqual(timeline.state.messages[0], visibleMessage);
});

test('message remove 的级联记录会从 materialized state 增量清理', () => {
  const { store, timeline, conversationId } = createStoreTimeline();
  for (const state of [timeline.pageState, timeline.retainedState, timeline.state]) {
    state.messages.push(message('message-1', conversationId, 'A'));
    state.toolCalls.push(toolCall('tool-1', 'message-1'));
    state.toolCallEvents.push(toolEvent('event-1', 'tool-1'));
  }

  store.applyTimelinePatch({
    conversationId,
    commitSeq: 1,
    patches: [{ kind: 'message.remove', id: 'message-1' }]
  });

  assert.equal(timeline.state.messages.length, 0);
  assert.equal(timeline.state.toolCalls.length, 0);
  assert.equal(timeline.state.toolCallEvents.length, 0);
});
