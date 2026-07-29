const assert = require('node:assert/strict');
const test = require('node:test');

const { GlobalSettingsBridge } = require('../dist/extension/backend/application/GlobalSettingsBridge.js');
const { SettingsRevisionConflictError } = require('../dist/extension/backend/capabilities/settingsRevisionConflict.js');
const { BridgeMessageType, globalSettingsStreamId } = require('../dist/extension/shared/protocol.js');

function stored(section, revision = `revision-${section}`, settings = { value: section }) {
  return { section, settings, filePath: `/settings/${section}.json`, revision };
}

function createWebviewRecorder() {
  const calls = [];
  return {
    calls,
    subscribe(clientId, streamId) { calls.push({ kind: 'subscribe', clientId, streamId }); },
    post(clientId, message) { calls.push({ kind: 'post', clientId, message }); },
    broadcastToStream(streamId, message, options) { calls.push({ kind: 'broadcast', streamId, message, options }); }
  };
}

function updatePayload(section = 'appearance') {
  return {
    section,
    settings: section === 'appearance'
      ? {
          streamingTextPreparing: '准备', streamingTextWaiting: '等待', streamingTextThinking: '思考',
          streamingTextWriting: '写入', streamingTextToolExecuting: '工具'
        }
      : { maxStoredInlineFileMb: 10 },
    expectedRevision: 'base-revision'
  };
}

test('设置保存 ack 只发给请求 client，其它订阅者只收到无 correlation external snapshot', async () => {
  const webview = createWebviewRecorder();
  const next = stored('appearance', 'next-revision', updatePayload().settings);
  const storage = {
    saveGlobalSettings: async () => next,
    loadGlobalSettings: async () => next
  };
  const bridge = new GlobalSettingsBridge({ storage, webview });

  await bridge.update(updatePayload(), 'request-A', 'client-A');

  const posts = webview.calls.filter((call) => call.kind === 'post');
  const broadcasts = webview.calls.filter((call) => call.kind === 'broadcast');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].clientId, 'client-A');
  assert.equal(posts[0].message.type, BridgeMessageType.GlobalSettingsSnapshot);
  assert.equal(posts[0].message.correlationId, 'request-A');
  assert.equal(posts[0].message.payload.revision, 'next-revision');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].streamId, globalSettingsStreamId('appearance'));
  assert.equal(broadcasts[0].message.correlationId, undefined);
  assert.deepEqual(broadcasts[0].options, { excludeClientIds: ['client-A'] });
});

test('CAS 冲突只向请求者发送 correlated error，并先发布无 correlation 最新快照', async () => {
  const webview = createWebviewRecorder();
  const latest = stored('appearance', 'actual-revision', { ...updatePayload().settings, streamingTextWriting: 'external' });
  const storage = {
    saveGlobalSettings: async () => { throw new SettingsRevisionConflictError('appearance', 'base-revision', 'actual-revision'); },
    loadGlobalSettings: async () => latest
  };
  const bridge = new GlobalSettingsBridge({ storage, webview });

  await bridge.update(updatePayload(), 'request-conflict', 'client-A');

  const posts = webview.calls.filter((call) => call.kind === 'post');
  const broadcasts = webview.calls.filter((call) => call.kind === 'broadcast');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].message.type, BridgeMessageType.GlobalSettingsSnapshot);
  assert.equal(posts[0].message.correlationId, undefined);
  assert.equal(posts[0].message.payload.revision, 'actual-revision');
  assert.equal(posts[1].message.type, BridgeMessageType.Error);
  assert.equal(posts[1].message.correlationId, 'request-conflict');
  assert.equal(posts[1].message.payload.code, 'settings_revision_conflict');
  assert.equal(posts[1].message.payload.actualRevision, 'actual-revision');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].message.type, BridgeMessageType.GlobalSettingsSnapshot);
  assert.equal(broadcasts[0].message.correlationId, undefined);
  assert.deepEqual(broadcasts[0].options, { excludeClientIds: ['client-A'] });
  assert.equal(webview.calls.some((call) => call.kind === 'broadcast' && call.message.type === BridgeMessageType.Error), false);
});

test('post-commit 副作用失败不会把已经成功的设置提交伪装成 error', async () => {
  const webview = createWebviewRecorder();
  const next = stored('attachments', 'next-revision', { maxStoredInlineFileMb: 10 });
  let afterCommitStarted = false;
  const bridge = new GlobalSettingsBridge({
    storage: {
      saveGlobalSettings: async () => next,
      loadGlobalSettings: async () => next
    },
    webview,
    afterCommit: async () => {
      afterCommitStarted = true;
      throw new Error('runtime-refresh-failed');
    }
  });

  await bridge.update(updatePayload('attachments'), 'request-commit', 'client-A');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(afterCommitStarted, true);
  assert.ok(webview.calls.some((call) => call.kind === 'post'
    && call.message.type === BridgeMessageType.GlobalSettingsSnapshot
    && call.message.correlationId === 'request-commit'));
  assert.equal(webview.calls.some((call) => call.message?.type === BridgeMessageType.Error), false);
});
