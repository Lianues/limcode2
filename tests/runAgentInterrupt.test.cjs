const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Agent } = require('../dist/extension/backend/world/modules/agent/components.js');
const {
  AgentRun,
  AgentRunNeedsModel,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunToolPolicyLink,
  ToolCallRunLink
} = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { AgentRunLifecycleSystem } = require('../dist/extension/backend/world/modules/agentRun/systems/AgentRunLifecycleSystem.js');
const { Conversation, Message, PartOf } = require('../dist/extension/backend/world/modules/chat/components.js');
const { ToolPolicy } = require('../dist/extension/backend/world/modules/mode/components.js');
const { ToolCall, ToolResultConsumed, ToolState } = require('../dist/extension/backend/world/modules/tools/components.js');
const { ToolDefinitionsKey } = require('../dist/extension/backend/world/modules/tools/resources.js');
const { ToolDispatchSystem } = require('../dist/extension/backend/world/modules/tools/systems/ToolDispatchSystem.js');
const { ToolResultSystem } = require('../dist/extension/backend/world/modules/tools/systems/ToolResultSystem.js');

const ANSWER_BRIDGE_ID = 'agent-answer:test-child';

test('run_agent interrupt only cancels the selected child subtree and keeps the caller run alive', () => {
  const world = new MapWorld();
  const mainAgent = addAgent(world, 'main');
  const childAgent = addAgent(world, 'reviewer-child');
  const grandchildAgent = addAgent(world, 'worker-grandchild');
  const siblingAgent = addAgent(world, 'explore-sibling');
  const mainConversation = addConversation(world, 'conversation-main');
  const childConversation = addConversation(world, 'conversation-child');
  const grandchildConversation = addConversation(world, 'conversation-grandchild');
  const siblingConversation = addConversation(world, 'conversation-sibling');

  const mainRun = addRun(world, {
    id: 'run-main',
    kind: 'chat',
    status: 'waiting_tool',
    agent: mainAgent,
    conversation: mainConversation,
    createdAt: 10
  });
  const childRun = addRun(world, {
    id: 'run-child',
    status: 'running',
    agent: childAgent,
    conversation: childConversation,
    createdAt: 20,
    sourceKind: 'toolCall',
    sourceRun: mainRun,
    sourceAgent: mainAgent,
    sourceConversation: mainConversation,
    answerBridgeId: ANSWER_BRIDGE_ID
  });
  const grandchildRun = addRun(world, {
    id: 'run-grandchild',
    status: 'running',
    agent: grandchildAgent,
    conversation: grandchildConversation,
    createdAt: 30,
    sourceKind: 'toolCall',
    sourceRun: childRun,
    sourceAgent: childAgent,
    sourceConversation: childConversation
  });
  const siblingRun = addRun(world, {
    id: 'run-sibling',
    status: 'running',
    agent: siblingAgent,
    conversation: siblingConversation,
    createdAt: 40,
    sourceKind: 'toolCall',
    sourceRun: mainRun,
    sourceAgent: mainAgent,
    sourceConversation: mainConversation
  });

  bindRunToolPolicy(world, mainRun, ['run_agent']);
  world.setResource(ToolDefinitionsKey, [{ name: 'run_agent', execution: 'agentRun' }]);

  const modelMessage = addModelMessage(world, mainConversation, mainRun, 100);
  const interruptCall = addToolCall(world, {
    run: mainRun,
    modelMessage,
    id: 'tool-interrupt-child',
    name: 'run_agent',
    args: {
      mode: 'interrupt',
      prompt: '',
      answerBridgeId: ANSWER_BRIDGE_ID,
      agent: { id: '', type: 'reviewer' },
      foregroundWaitMs: 0,
      wait: 'false',
      scheduling: 'parallel'
    },
    status: 'queued',
    createdAt: 110
  });

  ToolDispatchSystem.run({ world, cmd: commandSink(world), events: [] });

  const interruptState = world.get(interruptCall, ToolState);
  assert.equal(interruptState.status, 'success');
  assert.equal(interruptState.result.status, 'interrupt_requested');
  assert.equal(interruptState.result.interruptRequested, true);
  assert.equal('interrupted' in interruptState.result, false);

  const controlEvents = world.drainQueue();
  const cancelEvent = controlEvents.find((event) => event.type === 'agentRun:cancel');
  assert.ok(cancelEvent);
  assert.equal(cancelEvent.payload.runId, 'run-child');
  assert.equal(cancelEvent.payload.cascadeChildAgents, true);

  ToolResultSystem.run({ world, cmd: commandSink(world), events: [] });

  assert.equal(world.get(mainRun, AgentRun).status, 'running');
  assert.equal(world.has(mainRun, AgentRunNeedsModel), true);
  assert.equal(world.has(interruptCall, ToolResultConsumed), true);

  AgentRunLifecycleSystem.run({ world, cmd: commandSink(world), events: controlEvents });

  assert.equal(world.get(childRun, AgentRun).status, 'cancelled');
  assert.equal(world.get(grandchildRun, AgentRun).status, 'cancelled');
  assert.equal(world.get(mainRun, AgentRun).status, 'running');
  assert.equal(world.get(siblingRun, AgentRun).status, 'running');
});

test('interrupting an already stopped child is idempotent and keeps the caller run alive', () => {
  const world = new MapWorld();
  const mainAgent = addAgent(world, 'main-already-stopped');
  const childAgent = addAgent(world, 'child-already-stopped');
  const mainConversation = addConversation(world, 'conversation-main-already-stopped');
  const childConversation = addConversation(world, 'conversation-child-already-stopped');
  const mainRun = addRun(world, {
    id: 'run-main-already-stopped',
    kind: 'chat',
    status: 'waiting_tool',
    agent: mainAgent,
    conversation: mainConversation,
    createdAt: 10
  });
  addRun(world, {
    id: 'run-child-already-stopped',
    status: 'completed',
    agent: childAgent,
    conversation: childConversation,
    createdAt: 20,
    sourceKind: 'toolCall',
    sourceRun: mainRun,
    sourceAgent: mainAgent,
    sourceConversation: mainConversation,
    answerBridgeId: ANSWER_BRIDGE_ID
  });
  bindRunToolPolicy(world, mainRun, ['run_agent']);
  world.setResource(ToolDefinitionsKey, [{ name: 'run_agent', execution: 'agentRun' }]);
  const modelMessage = addModelMessage(world, mainConversation, mainRun, 100);
  const interruptCall = addToolCall(world, {
    run: mainRun,
    modelMessage,
    id: 'tool-interrupt-stopped-child',
    name: 'run_agent',
    args: { mode: 'interrupt', answerBridgeId: ANSWER_BRIDGE_ID },
    status: 'queued',
    createdAt: 110
  });

  ToolDispatchSystem.run({ world, cmd: commandSink(world), events: [] });

  const state = world.get(interruptCall, ToolState);
  assert.equal(state.status, 'success');
  assert.equal(state.result.status, 'already_stopped');
  assert.equal(state.result.interruptRequested, false);
  assert.equal(world.drainQueue().some((event) => event.type === 'agentRun:cancel'), false);

  ToolResultSystem.run({ world, cmd: commandSink(world), events: [] });
  assert.equal(world.get(mainRun, AgentRun).status, 'running');
  assert.equal(world.has(mainRun, AgentRunNeedsModel), true);
});

test('a successful tool result that describes an interrupted target does not cancel its own AgentRun', () => {
  const world = new MapWorld();
  const agent = addAgent(world, 'main-success-marker');
  const conversation = addConversation(world, 'conversation-success-marker');
  const run = addRun(world, {
    id: 'run-success-marker',
    status: 'waiting_tool',
    agent,
    conversation,
    createdAt: 10
  });
  bindRunToolPolicy(world, run, ['target_stop']);
  const modelMessage = addModelMessage(world, conversation, run, 100);
  addToolCall(world, {
    run,
    modelMessage,
    id: 'tool-success-marker',
    name: 'target_stop',
    args: {},
    status: 'success',
    result: { ok: true, interrupted: true, status: 'interrupt_requested' },
    createdAt: 110
  });

  ToolResultSystem.run({ world, cmd: commandSink(world), events: [] });

  assert.equal(world.get(run, AgentRun).status, 'running');
  assert.equal(world.has(run, AgentRunNeedsModel), true);
});

test('a canonical user-interrupted tool result still closes the run when every current-turn tool was interrupted', () => {
  const world = new MapWorld();
  const agent = addAgent(world, 'main-user-interrupt');
  const conversation = addConversation(world, 'conversation-user-interrupt');
  const run = addRun(world, {
    id: 'run-user-interrupt',
    status: 'waiting_tool',
    agent,
    conversation,
    createdAt: 10
  });
  bindRunToolPolicy(world, run, ['slow_tool']);
  const modelMessage = addModelMessage(world, conversation, run, 100);
  addToolCall(world, {
    run,
    modelMessage,
    id: 'tool-user-interrupt',
    name: 'slow_tool',
    args: {},
    status: 'error',
    result: { ok: false, interrupted: true, error: '工具已被用户中断执行。' },
    createdAt: 110
  });

  ToolResultSystem.run({ world, cmd: commandSink(world), events: [] });

  const runData = world.get(run, AgentRun);
  assert.equal(runData.status, 'cancelled');
  assert.equal(runData.endReason, 'cancelled_by_user');
  assert.equal(world.has(run, AgentRunNeedsModel), false);
});

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

function addRun(world, input) {
  const run = world.spawn();
  world.add(run, AgentRun, {
    id: input.id,
    kind: input.kind ?? 'tool_invoked',
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });

  const targetLink = world.spawn();
  world.add(targetLink, AgentRunTargetLink, {
    id: `target-${input.id}`,
    run,
    agent: input.agent,
    conversation: input.conversation,
    role: 'executor',
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });

  if (input.sourceRun !== undefined || input.answerBridgeId) {
    const sourceLink = world.spawn();
    world.add(sourceLink, AgentRunSourceLink, {
      id: `source-${input.id}`,
      run,
      sourceKind: input.sourceKind ?? 'agentRun',
      ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
      ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent } : {}),
      ...(input.sourceConversation !== undefined ? { sourceConversation: input.sourceConversation } : {}),
      ...(input.answerBridgeId ? { answerBridgeId: input.answerBridgeId } : {}),
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    });
  }
  return run;
}

function bindRunToolPolicy(world, run, allowedTools) {
  const policy = world.spawn();
  world.add(policy, ToolPolicy, {
    id: `policy-${run}`,
    name: `policy-${run}`,
    allowedTools
  });
  const link = world.spawn();
  world.add(link, RunToolPolicyLink, {
    id: `run-policy-${run}`,
    run,
    toolPolicy: policy,
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });
}

function addModelMessage(world, conversation, run, seq) {
  const message = world.spawn();
  world.add(message, Message, {
    id: `model-${run}`,
    role: 'model',
    content: { role: 'model', parts: [] },
    status: 'complete',
    seq,
    createdAt: seq
  });
  world.add(message, PartOf, { parent: conversation });
  const link = world.spawn();
  world.add(link, MessageRunLink, {
    id: `model-link-${run}`,
    message,
    run,
    role: 'model',
    createdAt: seq,
    updatedAt: seq
  });
  return message;
}

function addToolCall(world, input) {
  const entity = world.spawn();
  world.add(entity, ToolCall, {
    id: input.id,
    functionCallId: input.id,
    name: input.name,
    argsJson: JSON.stringify(input.args),
    createdAt: input.createdAt
  });
  world.add(entity, ToolState, {
    status: input.status,
    updatedAt: input.createdAt,
    ...(input.result !== undefined ? { result: input.result } : {})
  });
  world.add(entity, PartOf, { parent: input.modelMessage });
  const link = world.spawn();
  world.add(link, ToolCallRunLink, {
    id: `tool-run-${input.id}`,
    toolCall: entity,
    run: input.run,
    role: 'produced_by',
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
  return entity;
}

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
