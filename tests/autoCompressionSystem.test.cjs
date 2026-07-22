const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const {
  Conversation,
  ConversationFullContextLoaded,
  Message,
  PartOf
} = require('../dist/extension/backend/world/modules/chat/components.js');
const {
  LlmInvocation,
  MessageLlmInvocationLink
} = require('../dist/extension/backend/world/modules/llm/components.js');
const {
  ToolCall,
  ToolResultConsumed,
  ToolState
} = require('../dist/extension/backend/world/modules/tools/components.js');
const {
  CompressionBlock
} = require('../dist/extension/backend/world/modules/compression/components.js');
const {
  AutoCompressionSystem
} = require('../dist/extension/backend/world/modules/compression/systems/AutoCompressionSystem.js');
const {
  selectLatestClosedCompressionBoundary
} = require('../dist/extension/backend/world/modules/compression/selection.js');
const {
  selectPreDispatchCompressionAnchor
} = require('../dist/extension/backend/world/modules/chat/systems/LlmDispatchSystem.js');

function commandSink(world, effects = [], events = []) {
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

function addConversation(world, id = 'conversation-1') {
  const entity = world.spawn();
  world.add(entity, Conversation, { id, title: '测试', visibility: 'visible' });
  world.add(entity, ConversationFullContextLoaded, { loadedAt: Date.now() });
  return entity;
}

function addMessage(world, conversation, input) {
  const entity = world.spawn();
  world.add(entity, Message, {
    id: input.id,
    role: input.role,
    model: input.model,
    content: { role: input.role, parts: input.parts },
    status: input.status ?? 'complete',
    seq: input.seq,
    createdAt: input.seq,
    ...(input.usageMetadata ? { usageMetadata: input.usageMetadata } : {})
  });
  world.add(entity, PartOf, { parent: conversation });
  return entity;
}

function addCompleteInvocation(world, modelMessage, input = {}) {
  const entity = world.spawn();
  const id = input.id ?? `invocation-${modelMessage}`;
  world.add(entity, LlmInvocation, {
    id,
    requestId: `request-${id}`,
    status: 'complete',
    settings: {
      providerConfigId: 'provider-1',
      providerConfigName: '测试渠道',
      provider: 'openai-responses',
      modelId: input.modelId ?? 'gpt-test',
      contextWindowTokens: input.contextWindowTokens ?? 272_000,
      compressionConfigId: 'compression-config-1',
      compressionMethodKind: input.methodKind ?? 'openai_responses_compact',
      compressionTrigger: {
        mode: input.triggerMode ?? 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: input.thresholdTokens ?? 252_000,
        thresholdPercent: 92.6,
        preserveLatestMessages: 8,
        reserveLatestUserMessageTokens: 20_000
      },
      toolCallFormat: 'function-call',
      stream: true,
      retryOnError: true,
      retryMaxAttempts: 3,
      enableMultimodalTools: true
    },
    usageMetadata: {
      promptTokenCount: input.promptTokenCount ?? 368_271,
      candidatesTokenCount: 30,
      totalTokenCount: input.totalTokenCount ?? 368_301
    },
    createdAt: input.createdAt ?? 1,
    completedAt: input.completedAt ?? 2
  });
  const link = world.spawn();
  world.add(link, MessageLlmInvocationLink, {
    id: `message-invocation-${id}`,
    message: modelMessage,
    invocation: entity,
    role: 'modelOutput',
    createdAt: 1,
    updatedAt: 2
  });
  return entity;
}

function runAutoCompression(world) {
  const effects = [];
  const events = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = () => undefined;
  console.warn = () => undefined;
  try {
    AutoCompressionSystem.run({ world, cmd: commandSink(world, effects, events), events: [] });
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  return { effects, events };
}

function blocks(world) {
  return world.query(CompressionBlock).map((entity) => world.get(entity, CompressionBlock));
}

test('普通模型响应超过 invocation 快照阈值后无需下一条用户消息即可自动压缩', () => {
  const world = new MapWorld();
  const conversation = addConversation(world);
  const user = addMessage(world, conversation, { id: 'user-1', seq: 100_000, role: 'user', parts: [{ text: '问题' }] });
  const model = addMessage(world, conversation, { id: 'model-1', seq: 200_000, role: 'model', model: 'gpt-test', parts: [{ text: '回答' }] });
  addCompleteInvocation(world, model);

  const first = runAutoCompression(world);
  assert.equal(blocks(world).length, 1);
  assert.equal(blocks(world)[0].anchorMessageId, 'model-1');
  assert.equal(blocks(world)[0].trigger, 'auto');
  assert.equal(first.effects.length, 1);
  assert.equal(first.effects[0].kind, 'llm.compact');
  assert.deepEqual(first.events, []);

  runAutoCompression(world);
  assert.equal(blocks(world).length, 1, '同一 invocation/边界不能重复创建压缩块');
  assert.ok(user > 0);
});

test('会话完整上下文未加载时不使用局部消息创建压缩块', () => {
  const world = new MapWorld();
  const conversation = addConversation(world);
  world.remove(conversation, ConversationFullContextLoaded);
  const model = addMessage(world, conversation, { id: 'model-partial', seq: 100_000, role: 'model', parts: [{ text: '回答' }] });
  addCompleteInvocation(world, model);

  runAutoCompression(world);
  assert.equal(blocks(world).length, 0);

  world.add(conversation, ConversationFullContextLoaded, { loadedAt: Date.now() });
  runAutoCompression(world);
  assert.equal(blocks(world).length, 1);
  assert.equal(blocks(world)[0].anchorMessageId, 'model-partial');
});

test('工具调用超过阈值时等待工具结果，结果落地后锚定完整工具结果', () => {
  const world = new MapWorld();
  const conversation = addConversation(world);
  addMessage(world, conversation, { id: 'user-1', seq: 100_000, role: 'user', parts: [{ text: '读取文件' }] });
  const model = addMessage(world, conversation, {
    id: 'model-call',
    seq: 200_000,
    role: 'model',
    parts: [{ id: 'function-1', functionCall: { name: 'read', args: { path: 'a.txt' } } }]
  });
  addCompleteInvocation(world, model);

  const toolCall = world.spawn();
  world.add(toolCall, ToolCall, { id: 'tool-1', functionCallId: 'function-1', name: 'read', argsJson: '{"path":"a.txt"}', createdAt: 2 });
  world.add(toolCall, PartOf, { parent: model });
  world.add(toolCall, ToolState, { status: 'running', updatedAt: 2 });

  runAutoCompression(world);
  assert.equal(blocks(world).length, 0);

  world.add(toolCall, ToolState, { status: 'success', result: { ok: true }, updatedAt: 3 });
  world.add(toolCall, ToolResultConsumed, true);
  addMessage(world, conversation, {
    id: 'tool-response',
    seq: 300_000,
    role: 'user',
    parts: [{ id: 'function-1', functionResponse: { name: 'read', response: { ok: true } } }]
  });

  runAutoCompression(world);
  assert.equal(blocks(world).length, 1);
  assert.equal(blocks(world)[0].anchorMessageId, 'tool-response');
  assert.equal(blocks(world)[0].endSeq, 300_000);
});

test('漏触发后存在后续闭合工具回合时选择最新工具结果而不是用户输入之前', () => {
  const world = new MapWorld();
  const conversation = addConversation(world);
  const output1 = addMessage(world, conversation, { id: 'output-1', seq: 100_000, role: 'model', parts: [{ text: '旧回答' }] });
  addCompleteInvocation(world, output1, { id: 'invocation-1', createdAt: 1, completedAt: 2 });
  addMessage(world, conversation, { id: 'user-2', seq: 200_000, role: 'user', parts: [{ text: '继续' }] });
  const toolModel = addMessage(world, conversation, {
    id: 'tool-call-3',
    seq: 300_000,
    role: 'model',
    parts: [{ id: 'function-3', functionCall: { name: 'read', args: {} } }]
  });
  addCompleteInvocation(world, toolModel, { id: 'invocation-3', createdAt: 3, completedAt: 4 });
  const toolCall = world.spawn();
  world.add(toolCall, ToolCall, { id: 'tool-3', functionCallId: 'function-3', name: 'read', argsJson: '{}', createdAt: 3 });
  world.add(toolCall, PartOf, { parent: toolModel });
  world.add(toolCall, ToolState, { status: 'success', result: { ok: true }, updatedAt: 4 });
  world.add(toolCall, ToolResultConsumed, true);
  const toolResponse = addMessage(world, conversation, {
    id: 'tool-response-4',
    seq: 400_000,
    role: 'user',
    parts: [{ id: 'function-3', functionResponse: { name: 'read', response: { ok: true } } }]
  });
  addMessage(world, conversation, { id: 'new-user', seq: 500_000, role: 'user', parts: [{ text: '新消息' }] });
  const pendingModel = addMessage(world, conversation, { id: 'pending-model', seq: 600_000, role: 'model', status: 'streaming', parts: [] });

  const messagesBeforePending = [output1, ...world.query(Message).filter((entity) => entity !== pendingModel && world.get(entity, PartOf)?.parent === conversation)];
  const boundary = selectLatestClosedCompressionBoundary(world, [...new Set(messagesBeforePending)]);
  assert.equal(boundary.id, 'tool-response-4');

  const dispatchAnchor = selectPreDispatchCompressionAnchor(world, {
    conversation,
    modelMessage: pendingModel,
    run: 999
  });
  assert.equal(dispatchAnchor.id, 'tool-response-4');
  assert.equal(dispatchAnchor.entity, toolResponse);

  // 自动重评也应直接合并到最新闭合工具结果，而不是先在 output-1 建立落后块。
  world.add(pendingModel, Message, { ...world.get(pendingModel, Message), status: 'error' });
  runAutoCompression(world);
  assert.equal(blocks(world).length, 1);
  assert.equal(blocks(world)[0].anchorMessageId, 'tool-response-4');
});

test('未闭合工具调用不会成为压缩边界，低于阈值或 manual 配置也不会自动压缩', () => {
  const world = new MapWorld();
  const conversation = addConversation(world);
  const prior = addMessage(world, conversation, { id: 'prior', seq: 100_000, role: 'model', parts: [{ text: '完成回答' }] });
  const callMessage = addMessage(world, conversation, {
    id: 'pending-call',
    seq: 200_000,
    role: 'model',
    parts: [{ id: 'pending-function', functionCall: { name: 'write', args: {} } }]
  });
  const toolCall = world.spawn();
  world.add(toolCall, ToolCall, { id: 'pending-tool', functionCallId: 'pending-function', name: 'write', argsJson: '{}', createdAt: 2 });
  world.add(toolCall, PartOf, { parent: callMessage });
  world.add(toolCall, ToolState, { status: 'running', updatedAt: 2 });

  assert.equal(selectLatestClosedCompressionBoundary(world, [prior, callMessage], { minSeq: 200_000 }), undefined);
  assert.equal(selectLatestClosedCompressionBoundary(world, [prior, callMessage]).id, 'prior');

  addCompleteInvocation(world, prior, { id: 'below-threshold', totalTokenCount: 10_000 });
  addCompleteInvocation(world, callMessage, { id: 'manual', methodKind: 'manual_summary' });
  runAutoCompression(world);
  assert.equal(blocks(world).length, 0);
});
