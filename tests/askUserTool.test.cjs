const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const {
  AgentRunSourceLink,
  AgentRunTargetLink,
  ToolCallRunLink
} = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { Conversation } = require('../dist/extension/backend/world/modules/chat/components.js');
const { OpenConversationPanelIdsKey } = require('../dist/extension/backend/world/modules/chat/resources.js');
const { askUserTool } = require('../dist/extension/backend/world/modules/tools/definitions/askUser/index.js');
const { ToolCall, ToolCallEvent, ToolState } = require('../dist/extension/backend/world/modules/tools/components.js');
const { ToolRuntimeDefinitionsKey } = require('../dist/extension/backend/world/modules/tools/resources.js');
const { activeExecutionBatchForRun } = require('../dist/extension/backend/world/modules/tools/scheduling.js');
const {
  AskUserSystem,
  BACKGROUND_ASK_USER_AUTO_ANSWER,
  isAwaitingBackgroundAskUserCall
} = require('../dist/extension/backend/world/modules/tools/systems/AskUserSystem.js');
const { createToolState, transitionToolState } = require('../dist/extension/backend/world/modules/tools/state.js');
const { simplifyToolResponseForModel } = require('../dist/extension/backend/world/modules/tools/responseSimplifier.js');
const {
  askUserOutputFromResult,
  normalizeAskUserToolRequest,
  resolveAskUserAnswer
} = require('../dist/extension/shared/askUser.js');

const requestArgs = {
  question: '应该如何继续？',
  options: [
    { label: '保留当前实现', description: '只修复现有问题' },
    { label: '替换实现', description: '重新设计相关模块' }
  ]
};

test('ask_user schema only asks for labels/descriptions and keeps multiple optional', () => {
  const declaration = askUserTool.declaration;
  const properties = declaration.parameters.properties;
  const optionSchema = properties.options.items;
  assert.equal(declaration.name, 'ask_user');
  assert.deepEqual(declaration.parameters.required, ['question', 'options']);
  assert.equal(properties.options.minItems, 2);
  assert.equal(properties.options.maxItems, 8);
  assert.deepEqual(optionSchema.required, ['label']);
  assert.deepEqual(Object.keys(optionSchema.properties).sort(), ['description', 'label']);
  assert.equal('allowCustom' in properties, false);
  assert.equal('multiple' in properties, true);
  assert.equal(declaration.parameters.required.includes('multiple'), false);
  assert.equal(declaration.metadata.defaultAutoExpand, true);
  assert.equal(askUserTool.scheduling(requestArgs, { toolName: 'ask_user' }).mode, 'parallel');
});

test('normalization defaults omitted multiple to single choice', () => {
  const request = normalizeAskUserToolRequest(requestArgs);
  assert.equal(request.multiple, false);
  assert.deepEqual(request.options[0], {
    label: '保留当前实现',
    description: '只修复现有问题'
  });

  const multiple = normalizeAskUserToolRequest({ ...requestArgs, multiple: true });
  assert.equal(multiple.multiple, true);
});

test('normalization rejects duplicate labels and undersized option lists', () => {
  assert.throws(() => normalizeAskUserToolRequest({
    ...requestArgs,
    options: [
      { label: '相同', description: '说明一' },
      { label: '相同', description: '说明二' }
    ]
  }), /option labels must be unique/);
  assert.throws(() => normalizeAskUserToolRequest({
    question: '请选择',
    options: [{ label: '唯一选项' }]
  }), /2 to 8 items/);
});

test('single-choice answers resolve by option index and return the selected label to the model', () => {
  const request = normalizeAskUserToolRequest(requestArgs);
  const output = resolveAskUserAnswer(request, { selectedOptionIndexes: [0] });
  assert.deepEqual(output, {
    kind: 'ask_user.result',
    question: '应该如何继续？',
    multiple: false,
    selectedOptions: [{ label: '保留当前实现', description: '只修复现有问题' }]
  });
  assert.deepEqual(askUserOutputFromResult({ ok: true, output }), output);
  assert.deepEqual(simplifyToolResponseForModel('ask_user', 'success', { ok: true, output }), {
    answer: '保留当前实现'
  });
});

test('custom answers are always supported without an AI parameter', () => {
  const request = normalizeAskUserToolRequest(requestArgs);
  const output = resolveAskUserAnswer(request, {
    selectedOptionIndexes: [],
    customText: '  使用另一种方案  '
  });
  assert.deepEqual(output.selectedOptions, []);
  assert.equal(output.customText, '使用另一种方案');
  assert.deepEqual(simplifyToolResponseForModel('ask_user', 'success', { ok: true, output }), {
    answer: '使用另一种方案'
  });
});

test('single-choice rejects multiple options or mixing an option with custom text', () => {
  const request = normalizeAskUserToolRequest(requestArgs);
  assert.throws(
    () => resolveAskUserAnswer(request, { selectedOptionIndexes: [0, 1] }),
    /only one option/
  );
  assert.throws(
    () => resolveAskUserAnswer(request, { selectedOptionIndexes: [0], customText: '补充说明' }),
    /cannot combine/
  );
});

test('multiple choice accepts several labels plus a custom description', () => {
  const request = normalizeAskUserToolRequest({
    question: '需要同时处理哪些部分？',
    options: [
      { label: '后端' },
      { label: '前端' },
      { label: '测试' }
    ],
    multiple: true
  });
  const output = resolveAskUserAnswer(request, {
    selectedOptionIndexes: [2, 0],
    customText: '同时更新文档'
  });
  assert.deepEqual(output.selectedOptions, [{ label: '后端' }, { label: '测试' }]);
  assert.equal(output.customText, '同时更新文档');
  assert.deepEqual(simplifyToolResponseForModel('ask_user', 'success', { ok: true, output }), {
    answers: ['后端', '测试', '同时更新文档']
  });
});

test('parallel ask_user calls share the active batch and stop at a serial boundary', () => {
  const world = new MapWorld();
  const run = world.spawn();
  const ask1 = addToolCall(world, run, 'ask-1', 'ask_user', 1);
  const ask2 = addToolCall(world, run, 'ask-2', 'ask_user', 2);
  addToolCall(world, run, 'serial-1', 'serial_tool', 3);
  addToolCall(world, run, 'ask-3', 'ask_user', 4);
  world.setResource(ToolRuntimeDefinitionsKey, [askUserTool, serialTool]);

  const batch = activeExecutionBatchForRun(world, run);
  assert.equal(batch.mode, 'parallel');
  assert.deepEqual([...batch.calls], [ask1, ask2]);
});

test('AskUserSystem consumes the first valid multiple answer and completes the tool call', () => {
  const world = new MapWorld();
  const entity = world.spawn();
  const args = { ...requestArgs, multiple: true };
  world.add(entity, ToolCall, {
    id: 'ask-1',
    name: 'ask_user',
    functionCallId: 'ask-1',
    argsJson: JSON.stringify(args),
    createdAt: Date.now() - 20
  });
  world.add(entity, ToolState, createToolState('awaiting_user_input'));

  AskUserSystem.run({
    world,
    cmd: commandSink(world),
    events: [
      { type: 'tool:askUserAnswerSubmitted', payload: { toolCallId: 'ask-1', answer: { selectedOptionIndexes: [0, 1] } } },
      { type: 'tool:askUserAnswerSubmitted', payload: { toolCallId: 'ask-1', answer: { selectedOptionIndexes: [], customText: '迟到回答' } } }
    ]
  });

  const state = world.get(entity, ToolState);
  assert.equal(state.status, 'success');
  assert.deepEqual(state.result.output.selectedOptions.map((option) => option.label), ['保留当前实现', '替换实现']);
  const events = world.query(ToolCallEvent).map((eventEntity) => world.get(eventEntity, ToolCallEvent));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'completed');
  assert.equal(events[0].status, 'success');
});

test('closed main conversation panel auto-answers ask_user with the fixed custom response', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, {
    targetConversationId: 'conversation-main'
  });
  world.setResource(OpenConversationPanelIdsKey, []);
  const entity = addToolCall(world, run, 'ask-background-main', 'ask_user', Date.now() - 20);
  world.add(entity, ToolState, createToolState('awaiting_user_input'));

  const events = [{
    type: 'chat:conversationPanelPresenceChanged',
    payload: { conversationId: 'conversation-main', open: false }
  }];
  assert.equal(isAwaitingBackgroundAskUserCall(world, entity), true);
  assert.equal(AskUserSystem.shouldRun({ world, events }), true);
  AskUserSystem.run({ world, cmd: commandSink(world), events });

  const state = world.get(entity, ToolState);
  assert.equal(state.status, 'success');
  assert.deepEqual(state.result.output.selectedOptions, []);
  assert.equal(state.result.output.customText, BACKGROUND_ASK_USER_AUTO_ANSWER);
  assert.deepEqual(simplifyToolResponseForModel('ask_user', 'success', state.result), {
    answer: BACKGROUND_ASK_USER_AUTO_ANSWER
  });
});

test('explicit user answer wins when the last panel closes in the same tick', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, {
    targetConversationId: 'conversation-closing'
  });
  world.setResource(OpenConversationPanelIdsKey, []);
  const entity = addToolCall(world, run, 'ask-closing', 'ask_user', Date.now() - 20);
  world.add(entity, ToolState, createToolState('awaiting_user_input'));
  const events = [
    {
      type: 'tool:askUserAnswerSubmitted',
      payload: { toolCallId: 'ask-closing', answer: { selectedOptionIndexes: [1] } }
    },
    {
      type: 'chat:conversationPanelPresenceChanged',
      payload: { conversationId: 'conversation-closing', open: false }
    }
  ];

  AskUserSystem.run({ world, cmd: commandSink(world), events });

  const output = world.get(entity, ToolState).result.output;
  assert.deepEqual(output.selectedOptions.map((option) => option.label), ['替换实现']);
  assert.equal(output.customText, undefined);
});

test('child agent auto-answers when only its parent conversation panel is open', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, {
    targetConversationId: 'conversation-child',
    sourceConversationId: 'conversation-parent'
  });
  world.setResource(OpenConversationPanelIdsKey, ['conversation-parent']);
  const entity = addToolCall(world, run, 'ask-child-with-parent-open', 'ask_user', Date.now() - 20);
  world.add(entity, ToolState, createToolState('awaiting_user_input'));

  assert.equal(isAwaitingBackgroundAskUserCall(world, entity), true);
  AskUserSystem.run({ world, cmd: commandSink(world), events: [] });
  const output = world.get(entity, ToolState).result.output;
  assert.equal(output.customText, BACKGROUND_ASK_USER_AUTO_ANSWER);
});

test('foreground ask_user keeps waiting when its conversation panel is open', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, {
    targetConversationId: 'conversation-foreground'
  });
  world.setResource(OpenConversationPanelIdsKey, ['conversation-foreground']);
  const entity = addToolCall(world, run, 'ask-foreground', 'ask_user', Date.now() - 20);
  world.add(entity, ToolState, createToolState('awaiting_user_input'));

  assert.equal(isAwaitingBackgroundAskUserCall(world, entity), false);
  assert.equal(AskUserSystem.shouldRun({ world, events: [] }), false);
  AskUserSystem.run({ world, cmd: commandSink(world), events: [] });
  assert.equal(world.get(entity, ToolState).status, 'awaiting_user_input');
});

test('child agent keeps waiting when its own target conversation panel is open', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, {
    targetConversationId: 'conversation-visible-child',
    sourceConversationId: 'conversation-closed-parent'
  });
  world.setResource(OpenConversationPanelIdsKey, ['conversation-visible-child']);
  const entity = addToolCall(world, run, 'ask-visible-child', 'ask_user', Date.now() - 20);
  world.add(entity, ToolState, createToolState('awaiting_user_input'));

  assert.equal(isAwaitingBackgroundAskUserCall(world, entity), false);
  AskUserSystem.run({ world, cmd: commandSink(world), events: [] });
  assert.equal(world.get(entity, ToolState).status, 'awaiting_user_input');
});

test('tool state supports the explicit awaiting_user_input lifecycle', () => {
  const queued = createToolState('queued', 1);
  const awaiting = transitionToolState(queued, 'awaiting_user_input', {}, 2);
  const completed = transitionToolState(awaiting, 'success', {
    result: {
      ok: true,
      output: resolveAskUserAnswer(normalizeAskUserToolRequest(requestArgs), { selectedOptionIndexes: [1] })
    }
  }, 3);

  assert.equal(awaiting.status, 'awaiting_user_input');
  assert.equal(completed.status, 'success');
  assert.throws(() => transitionToolState(awaiting, 'executing', {}, 3), /非法工具状态转换/);
});

const serialTool = {
  declaration: {
    name: 'serial_tool',
    description: 'test serial boundary',
    parameters: { type: 'object' }
  },
  execution: 'runtime',
  scheduling: () => ({ mode: 'serial', reason: 'test' }),
  async execute() {
    return { ok: true, output: {} };
  }
};

function addToolCall(world, run, id, name, createdAt) {
  const entity = world.spawn();
  world.add(entity, ToolCall, {
    id,
    name,
    argsJson: JSON.stringify(requestArgs),
    createdAt
  });
  world.add(entity, ToolState, createToolState('queued', createdAt));
  const link = world.spawn();
  world.add(link, ToolCallRunLink, {
    id: `link-${id}`,
    toolCall: entity,
    run,
    role: 'produced_by',
    createdAt,
    updatedAt: createdAt
  });
  return entity;
}

function addRunContext(world, run, input) {
  const targetConversation = world.spawn();
  world.add(targetConversation, Conversation, {
    id: input.targetConversationId,
    title: input.targetConversationId,
    visibility: 'visible'
  });
  const targetAgent = world.spawn();
  const targetLink = world.spawn();
  world.add(targetLink, AgentRunTargetLink, {
    id: `target-${run}`,
    run,
    agent: targetAgent,
    conversation: targetConversation,
    role: 'executor',
    createdAt: 1,
    updatedAt: 1
  });

  let sourceConversation;
  if (input.sourceConversationId) {
    sourceConversation = world.spawn();
    world.add(sourceConversation, Conversation, {
      id: input.sourceConversationId,
      title: input.sourceConversationId,
      visibility: 'visible'
    });
  }
  const sourceLink = world.spawn();
  world.add(sourceLink, AgentRunSourceLink, {
    id: `source-${run}`,
    run,
    sourceKind: sourceConversation === undefined ? 'user' : 'toolCall',
    ...(sourceConversation === undefined ? {} : { sourceConversation }),
    createdAt: 1,
    updatedAt: 1
  });

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
