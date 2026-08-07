const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { WebviewMessageRouter } = require('../dist/extension/backend/application/WebviewMessageRouter.js');
const { Agent, AgentConversationLink } = require('../dist/extension/backend/world/modules/agent/components.js');
const { AgentRunEventType } = require('../dist/extension/backend/world/modules/agentRun/events.js');
const { ChatEventType } = require('../dist/extension/backend/world/modules/chat/events.js');
const { Conversation, Message, PartOf } = require('../dist/extension/backend/world/modules/chat/components.js');
const { BridgeMessageType } = require('../dist/extension/shared/protocol.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createRouterFixture(role = 'model') {
  const world = new MapWorld();
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-1', title: '测试会话', visibility: 'visible' });
  const agent = world.spawn();
  world.add(agent, Agent, { id: 'agent-1', name: '测试 Agent', source: 'user' });
  const agentLink = world.spawn();
  world.add(agentLink, AgentConversationLink, {
    id: 'agent-conversation-1',
    agent,
    conversation,
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });
  const message = world.spawn();
  world.add(message, Message, {
    id: 'message-1',
    role,
    content: { role: role === 'model' ? 'model' : 'user', parts: [{ text: '原消息' }] },
    status: 'complete',
    seq: 1,
    createdAt: 1
  });
  world.add(message, PartOf, { parent: conversation });

  const flushStarted = deferred();
  const allowFlush = deferred();
  const truncateStarted = deferred();
  const allowTruncate = deferred();
  const posted = [];
  const storage = {
    loadConversationTimelineRange: async () => undefined,
    truncateConversationTimeline: async (request) => {
      truncateStarted.resolve(request);
      await allowTruncate.promise;
      return { conversationId: request.conversationId, removedMessageIds: [request.anchorMessageId] };
    }
  };
  const router = new WebviewMessageRouter({
    world,
    storage,
    webview: {
      post: (clientId, message) => posted.push({ clientId, message }),
      subscribe: () => undefined
    },
    clients: {},
    fs: {},
    llm: { cancelRetry: () => undefined },
    command: {},
    globalSettingsBridge: {},
    conversationSettingsBridge: {},
    isHydrated: () => true,
    requestSnapshot: () => undefined,
    requestPersist: () => undefined,
    flushConversationTimelinePersistence: async () => {
      flushStarted.resolve();
      await allowFlush.promise;
    },
    hydrateConversationTimelineRange: async () => false,
    ensureConversationDetailLoaded: async () => undefined,
    ensureConversationTailLoaded: async () => undefined,
    getProjectFolderCandidates: () => [],
    setConversationProjectFolder: () => false,
    importWorkEnvironmentsFromVscode: async () => 0,
    refreshSkillCatalog: async () => undefined,
    refreshRulesCatalog: async () => undefined,
    saveRuleFile: async () => undefined
  });

  return { world, router, storage, flushStarted, allowFlush, truncateStarted, allowTruncate, posted };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function hasSuccessfulOperationResult(fixture, operation) {
  return fixture.posted.some(({ message }) =>
    message.type === BridgeMessageType.OperationResult
      && message.payload?.ok === true
      && message.payload?.operation === operation
  );
}

function abortMessage(id = 'abort-request') {
  return {
    id,
    type: BridgeMessageType.ChatAbort,
    payload: { conversationId: 'conversation-1' }
  };
}

test('timeline page 错误保留原请求 correlationId 与 conversation scope', async () => {
  const fixture = createRouterFixture('model');
  fixture.storage.loadConversationTimelinePage = async () => {
    throw new Error('synthetic page failure');
  };

  fixture.router.handle('client-1', {
    id: 'timeline-page-request-a',
    type: BridgeMessageType.ConversationTimelinePageGet,
    channel: 'state',
    payload: { conversationId: 'conversation-a', direction: 'initial', chunkCount: 2 }
  });
  await settle();

  const error = fixture.posted.find(({ message }) =>
    message.type === BridgeMessageType.Error
      && message.payload?.requestType === BridgeMessageType.ConversationTimelinePageGet
  )?.message;
  assert.ok(error);
  assert.equal(error.correlationId, 'timeline-page-request-a');
  assert.equal(error.payload.conversationId, 'conversation-a');
  assert.deepEqual(error.scope, { kind: 'conversation', id: 'conversation-a' });
});

test('删除严格等待 timeline 持久化与 truncate 后才提交 ECS', async () => {
  const fixture = createRouterFixture('model');
  fixture.router.handle('client-1', {
    id: 'delete-request',
    type: BridgeMessageType.MessageDeleteFrom,
    payload: { conversationId: 'conversation-1', messageId: 'message-1' }
  });

  await fixture.flushStarted.promise;
  await settle();
  assert.deepEqual(fixture.world.drainQueue(), []);
  assert.equal(hasSuccessfulOperationResult(fixture, BridgeMessageType.MessageDeleteFrom), false);

  fixture.allowFlush.resolve();
  await fixture.truncateStarted.promise;
  await settle();
  assert.deepEqual(fixture.world.drainQueue(), []);

  fixture.allowTruncate.resolve();
  await settle();
  const events = fixture.world.drainQueue();
  assert.ok(events.some((event) => event.type === ChatEventType.DeleteFrom));
  assert.equal(hasSuccessfulOperationResult(fixture, BridgeMessageType.MessageDeleteFrom), true);
});

test('等待 timeline 持久化期间中断重试会保留删除但不启动 Retry Run', async () => {
  const fixture = createRouterFixture('model');
  fixture.router.handle('client-1', {
    id: 'retry-request',
    type: BridgeMessageType.MessageRetryFrom,
    payload: { conversationId: 'conversation-1', messageId: 'message-1' }
  });
  await fixture.flushStarted.promise;

  fixture.router.handle('client-1', abortMessage());
  assert.ok(fixture.world.drainQueue().some((event) => event.type === AgentRunEventType.CancelConversation));

  fixture.allowFlush.resolve();
  await fixture.truncateStarted.promise;
  fixture.allowTruncate.resolve();
  await settle();
  const events = fixture.world.drainQueue();
  assert.ok(events.some((event) => event.type === ChatEventType.DeleteFrom));
  assert.equal(events.some((event) => event.type === ChatEventType.RetryFrom), false);
});

test('等待 timeline 持久化期间中断编辑会保存编辑但关闭 runAfterEdit', async () => {
  const fixture = createRouterFixture('user');
  fixture.router.handle('client-1', {
    id: 'edit-request',
    type: BridgeMessageType.MessageEdit,
    payload: {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      text: '编辑后的消息',
      deleteFollowing: true,
      runAfterEdit: true
    }
  });
  await fixture.flushStarted.promise;

  fixture.router.handle('client-1', abortMessage());
  fixture.world.drainQueue();
  fixture.allowFlush.resolve();
  await fixture.truncateStarted.promise;
  fixture.allowTruncate.resolve();
  await settle();
  const editEvent = fixture.world.drainQueue().find((event) => event.type === ChatEventType.Edit);
  assert.ok(editEvent);
  assert.equal(editEvent.payload.runAfterEdit, false);
  assert.equal(editEvent.payload.text, '编辑后的消息');
});

test.after(() => {
  Module._load = originalLoad;
});
