const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Scheduler } = require('../dist/extension/backend/ecs/Scheduler.js');
const { Agent, AgentConversationLink } = require('../dist/extension/backend/world/modules/agent/components.js');
const { ClientStateDirtyConversationIdsKey } = require('../dist/extension/backend/world/clientSync/resources.js');
const { Conversation, Message, PartOf } = require('../dist/extension/backend/world/modules/chat/components.js');
const { ChatEventType } = require('../dist/extension/backend/world/modules/chat/events.js');
const { InputSystem } = require('../dist/extension/backend/world/modules/chat/systems/InputSystem.js');
const { MessageDeleteSystem } = require('../dist/extension/backend/world/modules/chat/systems/MessageDeleteSystem.js');
const { registerChatSystems } = require('../dist/extension/backend/world/modules/chat/systems/index.js');

function addMessage(world, conversation, id, seq, text = id) {
  const entity = world.spawn();
  world.add(entity, Message, {
    id,
    role: 'user',
    content: { role: 'user', parts: [{ text }] },
    status: 'complete',
    seq,
    createdAt: seq
  });
  world.add(entity, PartOf, { parent: conversation });
  return entity;
}

test('聊天系统拓扑先提交消息变更再处理新输入', () => {
  const world = new MapWorld();
  const scheduler = new Scheduler(world);
  registerChatSystems(scheduler);

  const order = scheduler.getSystemOrder();
  const inputIndex = order.indexOf('InputSystem');
  assert.ok(inputIndex > order.indexOf('MessageEditSystem'));
  assert.ok(inputIndex > order.indexOf('MessageDeleteSystem'));
  assert.ok(inputIndex > order.indexOf('MessageRetrySystem'));
  scheduler.dispose();
});

test('同一 tick 删除后缀并发送新消息时不会吞掉新输入', async () => {
  const world = new MapWorld();
  world.setResource(ClientStateDirtyConversationIdsKey, { revision: 0, ids: [] });

  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-1', title: '测试会话', visibility: 'visible' });
  const agent = world.spawn();
  world.add(agent, Agent, { id: 'agent-1', name: '测试 Agent', source: 'user' });
  const link = world.spawn();
  world.add(link, AgentConversationLink, {
    id: 'agent-conversation-1',
    agent,
    conversation,
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });
  addMessage(world, conversation, 'message-1', 1);
  addMessage(world, conversation, 'message-2', 2);

  const scheduler = new Scheduler(world);
  scheduler.add(MessageDeleteSystem);
  scheduler.add(InputSystem);
  world.enqueue({
    type: ChatEventType.DeleteFrom,
    payload: { conversationId: 'conversation-1', messageId: 'message-2' }
  });
  world.enqueue({
    type: ChatEventType.Send,
    payload: { conversationId: 'conversation-1', text: '删除后发送的新消息' }
  });

  await scheduler.stopAndDrain();

  const messages = world
    .query(Message, PartOf)
    .filter((entity) => world.get(entity, PartOf)?.parent === conversation)
    .map((entity) => world.get(entity, Message))
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);
  assert.deepEqual(messages.map((message) => message.id).includes('message-2'), false);
  assert.deepEqual(
    messages.map((message) => message.content.parts[0]?.text),
    ['message-1', '删除后发送的新消息']
  );
});
