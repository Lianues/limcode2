const assert = require('node:assert/strict');
const test = require('node:test');

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Scheduler } = require('../dist/extension/backend/ecs/Scheduler.js');
const {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ConversationAgentSelection
} = require('../dist/extension/backend/world/modules/agent/components.js');
const {
  AgentBlueprintsKey,
  createDefaultAgentBlueprints
} = require('../dist/extension/backend/world/modules/agent/blueprints.js');
const { requestSpawnAgent } = require('../dist/extension/backend/world/modules/agent/requests.js');
const { AgentSpawnSystem } = require('../dist/extension/backend/world/modules/agent/systems/AgentSpawnSystem.js');
const {
  ConversationAgentBindingSystem
} = require('../dist/extension/backend/world/modules/agent/systems/ConversationAgentBindingSystem.js');
const { Conversation } = require('../dist/extension/backend/world/modules/chat/components.js');

function addAgent(world, id, name = id) {
  const entity = world.spawn();
  world.add(entity, Agent, { id, name, source: 'builtin' });
  world.add(entity, AgentKind, { kind: id });
  world.add(entity, AgentStatus, { status: 'idle' });
  return entity;
}

function addConversation(world, id, visibility = 'visible') {
  const entity = world.spawn();
  world.add(entity, Conversation, { id, title: id, visibility });
  return entity;
}

async function runSystem(world, system) {
  const scheduler = new Scheduler(world, { applyEffect() {} });
  scheduler.add(system);
  world.enqueue({ type: 'test:wake', payload: {} });
  await scheduler.stopAndDrain();
}

test('visible Conversation 缺少关系时持久补齐 LimCode Agent Link 与 active Selection', async () => {
  const world = new MapWorld();
  const main = addAgent(world, 'main', 'LimCode Agent');
  const conversation = addConversation(world, 'conversation-missing-binding');

  await runSystem(world, ConversationAgentBindingSystem);

  const links = world.query(AgentConversationLink).map((entity) => world.get(entity, AgentConversationLink));
  const selections = world.query(ConversationAgentSelection).map((entity) => world.get(entity, ConversationAgentSelection));
  assert.equal(links.length, 1);
  assert.equal(links[0].conversation, conversation);
  assert.equal(links[0].agent, main);
  assert.equal(links[0].role, 'default');
  assert.equal(selections.length, 1);
  assert.equal(selections[0].id, 'conversation-agent:conversation-missing-binding:main');
  assert.equal(selections[0].conversation, conversation);
  assert.equal(selections[0].agent, main);
  assert.equal(selections[0].role, 'active');
});

test('缺少 active Selection 时沿用已有 Conversation Agent Link，不擅自改回 main', async () => {
  const world = new MapWorld();
  addAgent(world, 'main', 'LimCode Agent');
  const reviewer = addAgent(world, 'reviewer', 'Reviewer');
  const conversation = addConversation(world, 'conversation-existing-link');
  const link = world.spawn();
  world.add(link, AgentConversationLink, {
    id: 'acl-existing-reviewer',
    agent: reviewer,
    conversation,
    role: 'participant',
    createdAt: 1,
    updatedAt: 1
  });

  await runSystem(world, ConversationAgentBindingSystem);

  assert.equal(world.query(AgentConversationLink).length, 1);
  const selection = world.get(world.query(ConversationAgentSelection)[0], ConversationAgentSelection);
  assert.equal(selection.agent, reviewer);
  assert.equal(selection.id, 'conversation-agent:conversation-existing-link:reviewer');
});

test('collapsed 子对话不被默认 Agent 修复器改写', async () => {
  const world = new MapWorld();
  addAgent(world, 'main', 'LimCode Agent');
  addConversation(world, 'conversation-collapsed', 'collapsed');

  await runSystem(world, ConversationAgentBindingSystem);

  assert.equal(world.query(AgentConversationLink).length, 0);
  assert.equal(world.query(ConversationAgentSelection).length, 0);
});

test('Agent 在请求执行前已恢复时仍创建请求拥有的 Conversation 与绑定关系', async () => {
  const world = new MapWorld();
  world.setResource(AgentBlueprintsKey, createDefaultAgentBlueprints());
  addAgent(world, 'main', 'LimCode Agent');
  requestSpawnAgent(world, {
    kind: 'main',
    agentId: 'main',
    agentName: 'LimCode Agent',
    conversationId: 'conversation-startup-race'
  });

  const scheduler = new Scheduler(world, { applyEffect() {} });
  scheduler.add(AgentSpawnSystem);
  await scheduler.stopAndDrain();

  const conversation = world.query(Conversation)
    .find((entity) => world.get(entity, Conversation)?.id === 'conversation-startup-race');
  assert.notEqual(conversation, undefined);
  assert.equal(world.query(AgentConversationLink).some((entity) => {
    const link = world.get(entity, AgentConversationLink);
    return link?.conversation === conversation && world.get(link.agent, Agent)?.id === 'main';
  }), true);
  assert.equal(world.query(ConversationAgentSelection).some((entity) => {
    const selection = world.get(entity, ConversationAgentSelection);
    return selection?.conversation === conversation && world.get(selection.agent, Agent)?.id === 'main';
  }), true);
});
