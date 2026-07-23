const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Agent } = require('../dist/extension/backend/world/modules/agent/components.js');
const {
  AgentRun,
  AgentRunNeedsModel
} = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { spawnAgentRun } = require('../dist/extension/backend/world/modules/agentRun/bundles.js');
const {
  ConversationFullContextLoaded
} = require('../dist/extension/backend/world/modules/chat/components.js');
const {
  spawnConversation,
  spawnUserMessage
} = require('../dist/extension/backend/world/modules/chat/bundles.js');
const { ContextAssemblySystem } = require('../dist/extension/backend/world/modules/chat/systems/ContextAssemblySystem.js');

test('ECS 新建对话可直接进入子 Agent 首轮 LLM 解析而不是等待存储加载', () => {
  const world = new MapWorld();
  const effects = [];
  const cmd = commandSink(world, effects);

  const agent = world.spawn();
  world.add(agent, Agent, { id: 'agent-worker', name: 'Worker', source: 'builtin' });

  const conversation = spawnConversation(cmd, {
    id: 'conversation-child-live',
    title: 'child live conversation',
    visibility: 'collapsed'
  });
  const inputMessage = spawnUserMessage(cmd, conversation, '请完成子 Agent 首轮任务');
  const run = spawnAgentRun(cmd, {
    id: 'run-child-live',
    kind: 'tool_invoked',
    agent,
    conversation,
    sourceKind: 'toolCall',
    inputMessage,
    deliveryMode: 'notification',
    includeTranscript: 'summary'
  });

  assert.equal(world.has(conversation, ConversationFullContextLoaded), true);

  ContextAssemblySystem.run({ world, cmd, events: [] });

  assert.equal(world.get(run, AgentRun).status, 'running');
  assert.equal(world.has(run, AgentRunNeedsModel), false);
  assert.equal(effects.some((effect) => effect.kind === 'conversation.context.load'), false);
  assert.equal(effects.some((effect) => effect.kind === 'llm.resolveInvocation'), true);
});

function commandSink(world, effects) {
  return {
    spawn: () => world.spawn(),
    despawn: (entity) => world.despawn(entity),
    add: (entity, component, value) => world.add(entity, component, value),
    remove: (entity, component) => world.remove(entity, component),
    setResource: (key, value) => world.setResource(key, value),
    enqueue: (event) => world.enqueue(event),
    effect: (effect) => effects.push(effect)
  };
}
