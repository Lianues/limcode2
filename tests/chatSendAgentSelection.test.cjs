const assert = require('node:assert/strict');
const test = require('node:test');

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Scheduler } = require('../dist/extension/backend/ecs/Scheduler.js');
const { Agent, AgentConversationLink } = require('../dist/extension/backend/world/modules/agent/components.js');
const { AgentRun } = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { ClientStateDirtyConversationIdsKey } = require('../dist/extension/backend/world/clientSync/resources.js');
const { Conversation, Message, PartOf } = require('../dist/extension/backend/world/modules/chat/components.js');
const { ChatEventType } = require('../dist/extension/backend/world/modules/chat/events.js');
const { InputSystem } = require('../dist/extension/backend/world/modules/chat/systems/InputSystem.js');
const { MessageRetrySystem } = require('../dist/extension/backend/world/modules/chat/systems/MessageRetrySystem.js');

function createInputFixture(bindAgent) {
  const world = new MapWorld();
  world.setResource(ClientStateDirtyConversationIdsKey, { revision: 0, ids: [] });

  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-1', title: '测试会话', visibility: 'visible' });

  if (bindAgent) {
    const agent = world.spawn();
    world.add(agent, Agent, { id: 'main', name: 'LimCode Agent', source: 'builtin' });
    const link = world.spawn();
    world.add(link, AgentConversationLink, {
      id: 'agent-conversation-link-1',
      agent,
      conversation,
      role: 'default',
      createdAt: 1,
      updatedAt: 1
    });
  }

  const effects = [];
  const scheduler = new Scheduler(world, { applyEffect: (effect) => effects.push(effect) });
  scheduler.add(InputSystem);
  return { world, scheduler, conversation, effects };
}

function addMessage(world, conversation, record) {
  const entity = world.spawn();
  world.add(entity, Message, record);
  world.add(entity, PartOf, { parent: conversation });
  return entity;
}

function conversationMessages(fixture) {
  return fixture.world
    .query(Message, PartOf)
    .filter((entity) => fixture.world.get(entity, PartOf)?.parent === fixture.conversation)
    .map((entity) => fixture.world.get(entity, Message))
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

test('未选择 Agent 时先落地用户消息，再生成复用聊天楼层的错误提示', async () => {
  const fixture = createInputFixture(false);
  fixture.world.enqueue({
    type: ChatEventType.Send,
    payload: { conversationId: 'conversation-1', text: '你好' }
  });

  await fixture.scheduler.stopAndDrain();

  const messages = conversationMessages(fixture);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].status, 'complete');
  assert.equal(messages[0].content.parts[0]?.text, '你好');
  assert.equal(messages[1].role, 'model');
  assert.equal(messages[1].status, 'error');
  assert.deepEqual(messages[1].content.parts, []);
  assert.equal(fixture.world.query(AgentRun).length, 0);

  const notice = fixture.effects.find((effect) => effect.kind === 'client.transientNotice');
  assert.ok(notice);
  assert.equal(notice.streamId, 'conversation:conversation-1:state');
  assert.equal(notice.payload.kind, 'error');
  assert.equal(notice.payload.conversationId, 'conversation-1');
  assert.equal(notice.payload.messageId, messages[1].id);
  assert.equal(notice.payload.message, '当前对话未选择 Agent，请先选择后再发送消息。');
  assert.equal(notice.payload.rawError.code, 'missing_agent');
});

test('未选择 Agent 时重试错误楼层会替换为新的错误楼层而不会挂起', async () => {
  const world = new MapWorld();
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-1', title: '测试会话', visibility: 'visible' });
  addMessage(world, conversation, {
    id: 'user-message-1',
    role: 'user',
    content: { role: 'user', parts: [{ text: '你好' }] },
    status: 'complete',
    seq: 1,
    createdAt: 1
  });
  addMessage(world, conversation, {
    id: 'missing-agent-error-1',
    role: 'model',
    content: { role: 'model', parts: [] },
    status: 'error',
    seq: 2,
    createdAt: 2
  });

  const effects = [];
  const scheduler = new Scheduler(world, { applyEffect: (effect) => effects.push(effect) });
  scheduler.add(MessageRetrySystem);
  world.enqueue({
    type: ChatEventType.RetryFrom,
    payload: { conversationId: 'conversation-1', messageId: 'missing-agent-error-1' }
  });

  await scheduler.stopAndDrain();

  const fixture = { world, conversation };
  const messages = conversationMessages(fixture);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 'user-message-1');
  assert.equal(messages[1].role, 'model');
  assert.equal(messages[1].status, 'error');
  assert.notEqual(messages[1].id, 'missing-agent-error-1');
  assert.equal(world.query(AgentRun).length, 0);

  const notice = effects.find((effect) => effect.kind === 'client.transientNotice');
  assert.ok(notice);
  assert.equal(notice.payload.messageId, messages[1].id);
  assert.equal(notice.payload.message, '当前对话未选择 Agent，请先选择后再发送消息。');
});

test('已绑定默认 Agent 时保持原有用户消息和 AgentRun 创建行为', async () => {
  const fixture = createInputFixture(true);
  fixture.world.enqueue({
    type: ChatEventType.Send,
    payload: { conversationId: 'conversation-1', text: '你好' }
  });

  await fixture.scheduler.stopAndDrain();

  const messages = conversationMessages(fixture);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content.parts[0]?.text, '你好');
  assert.equal(fixture.world.query(AgentRun).length, 1);
  assert.equal(fixture.effects.some((effect) => effect.kind === 'client.transientNotice'), false);
});
