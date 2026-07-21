const assert = require('node:assert/strict');
const test = require('node:test');

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { spawnAgentRun } = require('../dist/extension/backend/world/modules/agentRun/bundles.js');
const { AgentRun } = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { spawnMessage } = require('../dist/extension/backend/world/modules/chat/bundles.js');
const { Conversation, Message } = require('../dist/extension/backend/world/modules/chat/components.js');
const { spawnLlmInvocation } = require('../dist/extension/backend/world/modules/llm/bundles.js');
const { LlmInvocation } = require('../dist/extension/backend/world/modules/llm/components.js');
const { spawnToolCall } = require('../dist/extension/backend/world/modules/tools/bundles.js');
const { ToolCall } = require('../dist/extension/backend/world/modules/tools/components.js');
const { Agent } = require('../dist/extension/backend/world/modules/agent/components.js');
const { hydrateConversationDetail } = require('../dist/extension/backend/application/clientStateHydration.js');

function commandSink(world) {
  return {
    spawn: () => world.spawn(),
    despawn: (entity) => world.despawn(entity),
    add: (entity, component, value) => world.add(entity, component, value),
    remove: (entity, component) => world.remove(entity, component),
    setResource: (key, value) => world.setResource(key, value),
    enqueue: (event) => world.enqueue(event),
    effect: () => undefined
  };
}

function addConversation(world, id = 'conversation-test') {
  const entity = world.spawn();
  world.add(entity, Conversation, { id, visibility: 'visible' });
  return entity;
}

function addAgent(world, id = 'agent-test') {
  const entity = world.spawn();
  world.add(entity, Agent, { id, name: id, source: 'user' });
  return entity;
}

test('new core records use stable prefixed ids instead of ECS entity-derived ids', () => {
  const world = new MapWorld();
  const cmd = commandSink(world);
  const conversation = addConversation(world);
  const agent = addAgent(world);

  const messageEntity = spawnMessage(cmd, {
    conversation,
    role: 'user',
    content: { role: 'user', parts: [{ text: 'hello' }] }
  });
  const message = world.get(messageEntity, Message);
  assert.match(message.id, /^msg-/);
  assert.notEqual(message.id, `m${messageEntity}`);

  const runEntity = spawnAgentRun(cmd, {
    kind: 'chat',
    agent,
    conversation,
    sourceKind: 'user',
    sourceConversation: conversation,
    deliveryMode: 'direct_reply',
    includeTranscript: 'full'
  });
  const run = world.get(runEntity, AgentRun);
  assert.match(run.id, /^run-/);
  assert.notEqual(run.id, `run${runEntity}`);

  const invocationEntity = spawnLlmInvocation(cmd);
  const invocation = world.get(invocationEntity, LlmInvocation);
  assert.match(invocation.id, /^llmi-/);
  assert.match(invocation.requestId, /^llmreq-/);
  assert.notEqual(invocation.id, `llmi${invocationEntity}`);

  const toolCallEntity = spawnToolCall(cmd, { modelMessage: messageEntity, name: 'read', argsJson: '{}' });
  const toolCall = world.get(toolCallEntity, ToolCall);
  assert.match(toolCall.id, /^tc-/);
  assert.notEqual(toolCall.id, `tc${toolCallEntity}`);
});

test('hydrate rejects duplicate message ids instead of silently overwriting', async () => {
  const world = new MapWorld();
  addConversation(world, 'conversation-dup');
  const state = createEmptyClientState();
  state.messages.push(
    { id: 'msg-dup', conversationId: 'conversation-dup', role: 'user', content: { role: 'user', parts: [{ text: 'a' }] }, status: 'complete', createdAt: 1, seq: 1 },
    { id: 'msg-dup', conversationId: 'conversation-dup', role: 'user', content: { role: 'user', parts: [{ text: 'b' }] }, status: 'complete', createdAt: 2, seq: 2 }
  );

  await assert.rejects(
    () => hydrateConversationDetail(world, state, 'conversation-dup'),
    /Duplicate .*msg-dup/
  );
});

test('hydrate normalizes restored active runs to cancelled', async () => {
  const world = new MapWorld();
  addConversation(world, 'conversation-run-normalize');
  const state = createEmptyClientState();
  state.agentRuns.push({
    id: 'run-active-before-restart',
    kind: 'chat',
    status: 'running',
    createdAt: 1,
    updatedAt: 2
  });

  await hydrateConversationDetail(world, state, 'conversation-run-normalize');
  const runEntity = world.query(AgentRun).find((entity) => world.get(entity, AgentRun)?.id === 'run-active-before-restart');
  assert.ok(runEntity !== undefined);
  const run = world.get(runEntity, AgentRun);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.endReason, 'cancelled_by_policy');
  assert.equal(run.errorType, 'cancelled');
});
