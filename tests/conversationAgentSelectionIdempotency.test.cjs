const assert = require('node:assert/strict');
const test = require('node:test');

const { CommandBuffer } = require('../dist/extension/backend/ecs/CommandBuffer.js');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const {
  Agent,
  ConversationAgentSelection
} = require('../dist/extension/backend/world/modules/agent/components.js');
const {
  ensureConversationAgentSelection
} = require('../dist/extension/backend/world/modules/agent/bundles.js');
const { Conversation } = require('../dist/extension/backend/world/modules/chat/components.js');

function addAgent(world, id) {
  const entity = world.spawn();
  world.add(entity, Agent, { id, name: id, source: 'builtin' });
  return entity;
}

function addConversation(world, id) {
  const entity = world.spawn();
  world.add(entity, Conversation, { id, title: id, visibility: 'visible' });
  return entity;
}

function commit(world, commandBuffer) {
  world.commit(commandBuffer.commands(), () => undefined);
}

test('同一 CommandBuffer 内重复 ensure active selection 只生成一个 entity，并以最后一次选择为准', () => {
  const world = new MapWorld();
  const conversationId = 'conversation-selection-same-wave';
  const conversation = addConversation(world, conversationId);
  const firstAgent = addAgent(world, 'agent-first');
  const lastAgent = addAgent(world, 'agent-last');
  const cmd = new CommandBuffer(world);

  const firstEntity = ensureConversationAgentSelection(world, cmd, {
    conversation,
    conversationId,
    agent: firstAgent,
    agentId: 'agent-first'
  });
  const lastEntity = ensureConversationAgentSelection(world, cmd, {
    conversation,
    conversationId,
    agent: lastAgent,
    agentId: 'agent-last'
  });

  assert.equal(lastEntity, firstEntity);
  commit(world, cmd);

  const entities = world.query(ConversationAgentSelection);
  assert.equal(entities.length, 1);
  assert.equal(entities[0], firstEntity);
  const selection = world.get(firstEntity, ConversationAgentSelection);
  assert.equal(selection.id, 'conversation-agent:conversation-selection-same-wave:agent-last');
  assert.equal(selection.conversation, conversation);
  assert.equal(selection.agent, lastAgent);
  assert.equal(selection.role, 'active');
  assert.equal(Number.isFinite(selection.createdAt), true);
  assert.equal(Number.isFinite(selection.updatedAt), true);
});

test('ensure active selection 会复用一条历史 relation 并清理同 conversation 重复 entity', () => {
  const world = new MapWorld();
  const conversationId = 'conversation-selection-repair';
  const conversation = addConversation(world, conversationId);
  const oldAgent = addAgent(world, 'agent-old');
  const selectedAgent = addAgent(world, 'agent-selected');

  const oldest = world.spawn();
  world.add(oldest, ConversationAgentSelection, {
    id: `conversation-agent:${conversationId}:agent-old`,
    conversation,
    agent: oldAgent,
    role: 'active',
    createdAt: 10,
    updatedAt: 20
  });
  const duplicate = world.spawn();
  world.add(duplicate, ConversationAgentSelection, {
    id: `conversation-agent:${conversationId}:agent-old`,
    conversation,
    agent: oldAgent,
    role: 'active',
    createdAt: 11,
    updatedAt: 21
  });

  const cmd = new CommandBuffer(world);
  const selected = ensureConversationAgentSelection(world, cmd, {
    conversation,
    conversationId,
    agent: selectedAgent,
    agentId: 'agent-selected'
  });
  commit(world, cmd);

  assert.equal(selected, oldest);
  assert.equal(world.query(ConversationAgentSelection).length, 1);
  assert.equal(world.has(duplicate, ConversationAgentSelection), false);
  const selection = world.get(oldest, ConversationAgentSelection);
  assert.equal(selection.id, `conversation-agent:${conversationId}:agent-selected`);
  assert.equal(selection.conversation, conversation);
  assert.equal(selection.agent, selectedAgent);
  assert.equal(selection.role, 'active');
  assert.equal(selection.createdAt, 10);
  assert.equal(Number.isFinite(selection.updatedAt), true);
});
