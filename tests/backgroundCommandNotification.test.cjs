const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Agent } = require('../dist/extension/backend/world/modules/agent/components.js');
const {
  AgentRun,
  AgentRunNeedsModel,
  AgentRunQueuedInput,
  AgentRunQueueHold,
  AgentRunTargetLink,
  ToolCallRunLink
} = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { spawnAgentRunNotification } = require('../dist/extension/backend/world/modules/agentRun/notificationDelivery.js');
const { AgentRunLifecycleSystem } = require('../dist/extension/backend/world/modules/agentRun/systems/AgentRunLifecycleSystem.js');
const { AgentRunQueueSystem } = require('../dist/extension/backend/world/modules/agentRun/systems/AgentRunQueueSystem.js');
const {
  BackgroundCommandNotificationSystem
} = require('../dist/extension/backend/world/modules/backgroundCommand/systems/BackgroundCommandNotificationSystem.js');
const { Conversation, InFlight, LlmRequest, Message, PartOf, Streaming } = require('../dist/extension/backend/world/modules/chat/components.js');
const { hasActiveUnresolvedFunctionCallsInEntities } = require('../dist/extension/backend/world/modules/compression/selection.js');
const { ToolCall, ToolResultConsumed, ToolState } = require('../dist/extension/backend/world/modules/tools/components.js');

function commandSink(world, events, effects = []) {
  return {
    spawn: () => world.spawn(),
    despawn: (entity) => world.despawn(entity),
    add: (entity, component, value) => world.add(entity, component, value),
    remove: (entity, component) => world.remove(entity, component),
    setResource: (key, value) => world.setResource(key, value),
    enqueue: (event) => {
      events.push(event);
      world.enqueue(event);
    },
    effect: (effect) => effects.push(effect)
  };
}

function createActiveFixture() {
  const world = new MapWorld();
  const agent = world.spawn();
  world.add(agent, Agent, { id: 'agent-main', name: '主 Agent', source: 'builtin' });
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-1', title: '测试', visibility: 'visible' });
  const activeRun = world.spawn();
  world.add(activeRun, AgentRun, {
    id: 'run-active',
    kind: 'chat',
    status: 'waiting_tool',
    createdAt: 1,
    updatedAt: 1
  });
  const targetLink = world.spawn();
  world.add(targetLink, AgentRunTargetLink, {
    id: 'target-active',
    run: activeRun,
    agent,
    conversation,
    role: 'executor',
    createdAt: 1,
    updatedAt: 1
  });
  const modelMessage = world.spawn();
  world.add(modelMessage, Message, {
    id: 'model-active',
    role: 'model',
    content: {
      role: 'model',
      parts: [{ id: 'call-active', functionCall: { name: 'read', args: { path: 'a.txt' } } }]
    },
    status: 'complete',
    seq: 100_000,
    createdAt: 1
  });
  world.add(modelMessage, PartOf, { parent: conversation });
  const toolCall = world.spawn();
  world.add(toolCall, ToolCall, {
    id: 'tool-active',
    functionCallId: 'call-active',
    name: 'read',
    argsJson: '{"path":"a.txt"}',
    createdAt: 2
  });
  world.add(toolCall, ToolState, { status: 'executing', updatedAt: 2 });
  world.add(toolCall, PartOf, { parent: modelMessage });
  const toolRunLink = world.spawn();
  world.add(toolRunLink, ToolCallRunLink, {
    id: 'tool-run-active',
    toolCall,
    run: activeRun,
    role: 'produced_by',
    createdAt: 2,
    updatedAt: 2
  });
  return { world, agent, conversation, activeRun, modelMessage, toolCall };
}

function createStreamingFixture() {
  const world = new MapWorld();
  const agent = world.spawn();
  world.add(agent, Agent, { id: 'agent-main', name: '主 Agent', source: 'builtin' });
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-streaming', title: '流式测试', visibility: 'visible' });
  const activeRun = world.spawn();
  world.add(activeRun, AgentRun, {
    id: 'run-streaming',
    kind: 'chat',
    status: 'running',
    createdAt: 1,
    updatedAt: 1
  });
  const targetLink = world.spawn();
  world.add(targetLink, AgentRunTargetLink, {
    id: 'target-streaming',
    run: activeRun,
    agent,
    conversation,
    role: 'executor',
    createdAt: 1,
    updatedAt: 1
  });
  const modelMessage = world.spawn();
  world.add(modelMessage, Message, {
    id: 'model-streaming',
    role: 'model',
    content: { role: 'model', parts: [{ text: 'partial response' }] },
    status: 'streaming',
    seq: 100_000,
    createdAt: 1
  });
  world.add(modelMessage, PartOf, { parent: conversation });
  world.add(modelMessage, Streaming, true);
  const request = world.spawn();
  world.add(request, LlmRequest, {
    id: 'llm-streaming',
    run: activeRun,
    conversation,
    modelMessage,
    createdAt: 2
  });
  world.add(request, InFlight, { kind: 'llm', startedAt: 2 });
  return { world, agent, conversation, activeRun, modelMessage, request };
}

function applyPromotionAndAssertClosed(fixture, promoteEvents) {
  assert.equal(promoteEvents.some((event) => event.type === 'agentRun:promote'), true);
  AgentRunLifecycleSystem.run({
    world: fixture.world,
    cmd: commandSink(fixture.world, []),
    events: promoteEvents
  });

  assert.equal(fixture.world.get(fixture.activeRun, AgentRun).status, 'cancelled');
  assert.equal(fixture.world.get(fixture.toolCall, ToolState).status, 'error');
  assert.equal(fixture.world.has(fixture.toolCall, ToolResultConsumed), true);
  const messages = fixture.world.query(Message)
    .filter((entity) => fixture.world.get(entity, PartOf)?.parent === fixture.conversation)
    .sort((left, right) => fixture.world.get(left, Message).seq - fixture.world.get(right, Message).seq);
  const responseMessages = messages.filter((entity) =>
    fixture.world.get(entity, Message).content.parts.some((part) => part.functionResponse)
  );
  assert.equal(responseMessages.length, 1);
  const responsePart = fixture.world.get(responseMessages[0], Message).content.parts[0];
  assert.equal(responsePart.id, 'call-active');
  assert.equal(responsePart.functionResponse.response.interrupted, true);
  assert.equal(hasActiveUnresolvedFunctionCallsInEntities(fixture.world, messages), false);
}

test('background command exit still force-promotes and closes interrupted tool calls with responses', () => {
  const fixture = createActiveFixture();
  const emittedEvents = [];
  BackgroundCommandNotificationSystem.run({
    world: fixture.world,
    cmd: commandSink(fixture.world, emittedEvents),
    events: [{
      type: 'backgroundCommand:exited',
      payload: {
        processId: 'bg-1',
        toolName: 'shell',
        runId: 'run-active',
        conversationId: 'conversation-1',
        command: 'echo done',
        cwd: 'f:\\111\\limcode2',
        status: 'exited',
        exitCode: 0,
        killed: false,
        stdout: 'done',
        stderr: ''
      }
    }]
  });

  applyPromotionAndAssertClosed(fixture, emittedEvents);
});

test('force-promoted notification aborts the active LLM and materializes the notification for the next request', () => {
  const fixture = createStreamingFixture();
  const emittedEvents = [];
  const effects = [];
  spawnAgentRunNotification(fixture.world, commandSink(fixture.world, emittedEvents, effects), {
    conversation: fixture.conversation,
    agent: fixture.agent,
    text: '[Background command exited]\nbackground result',
    sourceKind: 'system',
    sourceConversation: fixture.conversation,
    promoteIfActive: true
  });

  const notificationRun = fixture.world.query(AgentRun).find((entity) =>
    fixture.world.get(entity, AgentRun)?.kind === 'notification'
  );
  assert.notEqual(notificationRun, undefined);
  assert.equal(fixture.world.query(AgentRunQueueHold).some((entity) =>
    fixture.world.get(entity, AgentRunQueueHold)?.run === notificationRun
  ), true);

  AgentRunLifecycleSystem.run({
    world: fixture.world,
    cmd: commandSink(fixture.world, [], effects),
    events: emittedEvents
  });

  assert.equal(fixture.world.get(fixture.activeRun, AgentRun).status, 'cancelled');
  assert.equal(fixture.world.has(fixture.request, LlmRequest), false);
  assert.equal(fixture.world.has(fixture.modelMessage, Streaming), false);
  assert.deepEqual(effects.filter((effect) => effect.kind === 'llm.abort'), [
    { kind: 'llm.abort', requestId: 'llm-streaming' }
  ]);
  assert.equal(fixture.world.query(AgentRunQueueHold).some((entity) =>
    fixture.world.get(entity, AgentRunQueueHold)?.run === notificationRun
  ), false);

  AgentRunQueueSystem.run({
    world: fixture.world,
    cmd: commandSink(fixture.world, []),
    events: []
  });

  assert.equal(fixture.world.has(notificationRun, AgentRunNeedsModel), true);
  assert.equal(fixture.world.query(AgentRunQueuedInput).some((entity) =>
    fixture.world.get(entity, AgentRunQueuedInput)?.run === notificationRun
  ), false);
  const notificationMessage = fixture.world.query(Message)
    .map((entity) => fixture.world.get(entity, Message))
    .find((message) => message?.role === 'user' && message.content.parts.some((part) =>
      typeof part.text === 'string' && part.text.includes('[Background command exited]')
    ));
  assert.notEqual(notificationMessage, undefined);
});

test('background Agent answer force-promotion uses the same response-complete interruption path', () => {
  const fixture = createActiveFixture();
  const submitterRun = fixture.world.spawn();
  fixture.world.add(submitterRun, AgentRun, {
    id: 'run-child-complete',
    kind: 'tool_invoked',
    status: 'completed',
    createdAt: 3,
    updatedAt: 4,
    completedAt: 4,
    endReason: 'completed'
  });
  const emittedEvents = [];
  spawnAgentRunNotification(fixture.world, commandSink(fixture.world, emittedEvents), {
    conversation: fixture.conversation,
    agent: fixture.agent,
    text: '[Agent answer submitted]\n子 Agent 已返回结果。',
    sourceKind: 'agentRun',
    sourceRun: submitterRun,
    sourceConversation: fixture.conversation,
    promoteIfActive: true
  });

  applyPromotionAndAssertClosed(fixture, emittedEvents);
});
