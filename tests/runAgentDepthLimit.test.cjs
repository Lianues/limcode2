const assert = require('node:assert/strict');
const test = require('node:test');

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Agent, AgentKind } = require('../dist/extension/backend/world/modules/agent/components.js');
const { AgentBlueprintsKey, createDefaultAgentBlueprints } = require('../dist/extension/backend/world/modules/agent/blueprints.js');
const {
  AgentRun,
  AgentRunTargetLink,
  MessageRunLink,
  RunToolPolicyLink,
  ToolCallRunLink
} = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { Conversation, ConversationOriginLink, Message, PartOf } = require('../dist/extension/backend/world/modules/chat/components.js');
const { conversationOriginDepth } = require('../dist/extension/backend/world/modules/chat/queries.js');
const { ToolPolicy } = require('../dist/extension/backend/world/modules/workflow/components.js');
const { ToolCall, ToolState } = require('../dist/extension/backend/world/modules/tools/components.js');
const {
  DEFAULT_MAX_CHILD_AGENT_DEPTH,
  MAX_CHILD_AGENT_DEPTH_CONFIG_KEY,
  RUN_AGENT_TOOL_NAME,
  runAgentTool
} = require('../dist/extension/backend/world/modules/tools/definitions/runAgent/index.js');
const { ToolDefinitionsKey } = require('../dist/extension/backend/world/modules/tools/resources.js');
const { activeExecutionBatchForRun } = require('../dist/extension/backend/world/modules/tools/scheduling.js');
const { ToolDispatchSystem } = require('../dist/extension/backend/world/modules/tools/systems/ToolDispatchSystem.js');

const RUN_AGENT_DEFINITION = {
  id: RUN_AGENT_TOOL_NAME,
  name: RUN_AGENT_TOOL_NAME,
  description: runAgentTool.declaration.description,
  parameters: runAgentTool.declaration.parameters,
  execution: 'agentRun',
  metadata: { checkpoint: { before: false, after: false } },
  configSchema: runAgentTool.declaration.configSchema,
  defaultConfig: runAgentTool.declaration.defaultConfig
};

test('run_agent exposes a policy-only depth config with default 1', () => {
  const field = runAgentTool.declaration.configSchema.fields.find((candidate) => candidate.key === MAX_CHILD_AGENT_DEPTH_CONFIG_KEY);

  assert.ok(field);
  assert.equal(field.type, 'number');
  assert.equal(field.defaultValue, 1);
  assert.equal(DEFAULT_MAX_CHILD_AGENT_DEPTH, 1);
  assert.equal(runAgentTool.declaration.defaultConfig[MAX_CHILD_AGENT_DEPTH_CONFIG_KEY], 1);
  assert.equal(runAgentTool.declaration.parameters.properties[MAX_CHILD_AGENT_DEPTH_CONFIG_KEY], undefined);
});

test('conversation origin depth uses the earliest origin link and treats cycles as roots', () => {
  const world = new MapWorld();
  const root = addConversation(world, 'conversation-root');
  const alternateRoot = addConversation(world, 'conversation-alternate-root');
  const child = addConversation(world, 'conversation-child');
  const grandchild = addConversation(world, 'conversation-grandchild');

  addOriginLink(world, child, alternateRoot, 20, 'origin-child-later');
  addOriginLink(world, child, root, 10, 'origin-child-earliest');
  addOriginLink(world, grandchild, child, 30, 'origin-grandchild');

  assert.equal(conversationOriginDepth(world, root), 0);
  assert.equal(conversationOriginDepth(world, child), 1);
  assert.equal(conversationOriginDepth(world, grandchild), 2);

  addOriginLink(world, root, grandchild, 5, 'origin-cycle');
  assert.equal(conversationOriginDepth(world, root), 0);
  assert.equal(conversationOriginDepth(world, child), 0);
  assert.equal(conversationOriginDepth(world, grandchild), 0);
});

test('default max depth allows a root conversation to launch the first child Agent', () => {
  const fixture = createCallerFixture({ callerConversationId: 'conversation-root' });
  const runCountBefore = fixture.world.query(AgentRun).length;
  const conversationCountBefore = fixture.world.query(Conversation).length;
  assert.equal(activeExecutionBatchForRun(fixture.world, fixture.run)?.calls.has(fixture.toolCall), true);

  ToolDispatchSystem.run({ world: fixture.world, cmd: commandSink(fixture.world), events: [] });

  const state = fixture.world.get(fixture.toolCall, ToolState);
  assert.equal(state.status, 'success');
  assert.equal(state.result.status, 'backgrounded');
  assert.equal(fixture.world.query(AgentRun).length, runCountBefore + 1);
  assert.equal(fixture.world.query(Conversation).length, conversationCountBefore + 1);

  const childConversation = fixture.world.query(Conversation).find((entity) => entity !== fixture.conversation);
  assert.notEqual(childConversation, undefined);
  assert.equal(conversationOriginDepth(fixture.world, childConversation), 1);
});

test('a first-level child Agent cannot launch a second-level Agent with the default max depth', () => {
  const fixture = createChildCallerFixture();
  const runCountBefore = fixture.world.query(AgentRun).length;
  const conversationCountBefore = fixture.world.query(Conversation).length;

  ToolDispatchSystem.run({ world: fixture.world, cmd: commandSink(fixture.world), events: [] });

  const state = fixture.world.get(fixture.toolCall, ToolState);
  assert.equal(state.status, 'error');
  assert.match(state.error, /当前对话层级为 1/);
  assert.match(state.error, /第 2 层/);
  assert.match(state.error, /上限为 1/);
  assert.equal(fixture.world.query(AgentRun).length, runCountBefore);
  assert.equal(fixture.world.query(Conversation).length, conversationCountBefore);
});

test('raising max depth to 2 allows a first-level child Agent to launch the second level', () => {
  const fixture = createChildCallerFixture({ maxDepth: 2 });
  const runCountBefore = fixture.world.query(AgentRun).length;
  const conversationCountBefore = fixture.world.query(Conversation).length;

  ToolDispatchSystem.run({ world: fixture.world, cmd: commandSink(fixture.world), events: [] });

  const state = fixture.world.get(fixture.toolCall, ToolState);
  assert.equal(state.status, 'success');
  assert.equal(state.result.status, 'backgrounded');
  assert.equal(fixture.world.query(AgentRun).length, runCountBefore + 1);
  assert.equal(fixture.world.query(Conversation).length, conversationCountBefore + 1);

  const secondLevelConversation = fixture.world.query(Conversation)
    .find((entity) => entity !== fixture.rootConversation && entity !== fixture.conversation);
  assert.notEqual(secondLevelConversation, undefined);
  assert.equal(conversationOriginDepth(fixture.world, secondLevelConversation), 2);
});

function createChildCallerFixture(options = {}) {
  const world = new MapWorld();
  world.setResource(AgentBlueprintsKey, createDefaultAgentBlueprints());
  world.setResource(ToolDefinitionsKey, [RUN_AGENT_DEFINITION]);

  const rootConversation = addConversation(world, 'conversation-root');
  const conversation = addConversation(world, 'conversation-child');
  addOriginLink(world, conversation, rootConversation, 10, 'origin-child');

  const agent = addAgent(world, 'agent-child', 'worker');
  const run = addRun(world, agent, conversation, 'run-child');
  bindRunToolPolicy(world, run, options.maxDepth);
  const modelMessage = addModelMessage(world, conversation, run, 100);
  const toolCall = addRunAgentToolCall(world, run, modelMessage, 'tool-run-agent-child', 110);
  return { world, rootConversation, conversation, agent, run, toolCall };
}

function createCallerFixture(options = {}) {
  const world = new MapWorld();
  world.setResource(AgentBlueprintsKey, createDefaultAgentBlueprints());
  world.setResource(ToolDefinitionsKey, [RUN_AGENT_DEFINITION]);

  const conversation = addConversation(world, options.callerConversationId ?? 'conversation-caller');
  const agent = addAgent(world, 'agent-main', 'main');
  const run = addRun(world, agent, conversation, 'run-main');
  bindRunToolPolicy(world, run, options.maxDepth);
  const modelMessage = addModelMessage(world, conversation, run, 100);
  const toolCall = addRunAgentToolCall(world, run, modelMessage, 'tool-run-agent', 110);
  return { world, conversation, agent, run, toolCall };
}

function addAgent(world, id, kind) {
  const entity = world.spawn();
  world.add(entity, Agent, { id, name: id, source: 'builtin' });
  world.add(entity, AgentKind, { kind });
  return entity;
}

function addConversation(world, id) {
  const entity = world.spawn();
  world.add(entity, Conversation, { id, title: id, visibility: 'visible' });
  return entity;
}

function addOriginLink(world, conversation, sourceConversation, createdAt, id) {
  const entity = world.spawn();
  world.add(entity, ConversationOriginLink, {
    id,
    conversation,
    originKind: 'agent',
    sourceKind: 'toolCall',
    sourceConversation,
    sourceConversationId: world.get(sourceConversation, Conversation).id,
    createdAt,
    updatedAt: createdAt
  });
  return entity;
}

function addRun(world, agent, conversation, id) {
  const run = world.spawn();
  world.add(run, AgentRun, {
    id,
    kind: 'tool_invoked',
    status: 'waiting_tool',
    createdAt: 1,
    updatedAt: 1
  });
  const target = world.spawn();
  world.add(target, AgentRunTargetLink, {
    id: `target-${id}`,
    run,
    agent,
    conversation,
    role: 'executor',
    createdAt: 1,
    updatedAt: 1
  });
  return run;
}

function bindRunToolPolicy(world, run, maxDepth) {
  const policy = world.spawn();
  world.add(policy, ToolPolicy, {
    id: `policy-${run}`,
    name: `policy-${run}`,
    allowedTools: [RUN_AGENT_TOOL_NAME],
    ...(maxDepth === undefined
      ? {}
      : {
        toolConfigs: {
          [RUN_AGENT_TOOL_NAME]: {
            config: { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: maxDepth }
          }
        }
      })
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

function addRunAgentToolCall(world, run, modelMessage, id, createdAt) {
  const entity = world.spawn();
  world.add(entity, ToolCall, {
    id,
    functionCallId: id,
    name: RUN_AGENT_TOOL_NAME,
    argsJson: JSON.stringify({
      mode: 'run',
      prompt: '执行子任务',
      agent: { type: 'worker' },
      foregroundWaitMs: 0
    }),
    createdAt
  });
  world.add(entity, ToolState, { status: 'queued', updatedAt: createdAt });
  world.add(entity, PartOf, { parent: modelMessage });
  const link = world.spawn();
  world.add(link, ToolCallRunLink, {
    id: `tool-run-${id}`,
    toolCall: entity,
    run,
    role: 'produced_by',
    createdAt,
    updatedAt: createdAt
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
