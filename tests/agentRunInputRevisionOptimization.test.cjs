const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const {
  Conversation,
  LlmRequest,
  LlmRequestPreDispatchCompressionAttempt,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf
} = require('../dist/extension/backend/world/modules/chat/components.js');
const {
  AgentRunInputRevision,
  MessageRunLink
} = require('../dist/extension/backend/world/modules/agentRun/components.js');
const {
  CompressionBlock,
  CompressionContextVariant,
  RunCompressionBlockLink
} = require('../dist/extension/backend/world/modules/compression/components.js');
const {
  buildRunContextContents,
  selectRunContextMessageEntities
} = require('../dist/extension/backend/world/modules/agentRun/contextPolicy.js');
const {
  projectConversationClientState
} = require('../dist/extension/backend/world/clientSync/systems/ClientSyncSystem.js');
const {
  LlmInvocation
} = require('../dist/extension/backend/world/modules/llm/components.js');
const {
  ToolDefinitionsKey,
  ToolSchemasKey
} = require('../dist/extension/backend/world/modules/tools/resources.js');
const {
  LlmDispatchSystem
} = require('../dist/extension/backend/world/modules/chat/systems/LlmDispatchSystem.js');
const {
  createEmptyClientState
} = require('../dist/extension/shared/clientStateSchema.js');

function addConversation(world, id = 'conversation-1') {
  const entity = world.spawn();
  world.add(entity, Conversation, { id, title: '测试会话', visibility: 'visible' });
  return entity;
}

function addMessage(world, conversation, id, seq, role = 'user', status = 'complete') {
  const entity = world.spawn();
  world.add(entity, Message, {
    id,
    role,
    content: { role, parts: [{ text: id }] },
    status,
    seq,
    createdAt: seq
  });
  world.add(entity, PartOf, { parent: conversation });
  return entity;
}

function linkMessageToRun(world, message, run, id) {
  const entity = world.spawn();
  world.add(entity, MessageRunLink, {
    id,
    message,
    run,
    role: 'input',
    createdAt: 1,
    updatedAt: 1
  });
}

function addCompleteCompression(world, conversation, kind, anchorOnly = false) {
  const block = world.spawn();
  world.add(block, CompressionBlock, {
    id: `block-${kind}-${anchorOnly ? 'anchor' : 'end'}`,
    conversation,
    title: '自动上下文压缩',
    status: 'complete',
    trigger: 'auto',
    methodKind: 'openai_responses_compact',
    anchorMessageId: 'before-boundary',
    anchorSeq: 200,
    startSeq: 100,
    ...(anchorOnly ? {} : { endSeq: 200 }),
    sourceMessageCount: 2,
    createdAt: 1,
    updatedAt: 1
  });
  const variant = world.spawn();
  world.add(variant, CompressionContextVariant, {
    id: `variant-${kind}-${anchorOnly ? 'anchor' : 'end'}`,
    block,
    kind,
    contents: [{ role: 'user', parts: [{ text: 'compacted context' }] }],
    createdAt: 1,
    updatedAt: 1
  });
}

function selectedMessageIds(world, selected) {
  return selected.map((entity) => world.get(entity, Message)?.id).filter(Boolean);
}

function addCurrentMessageRevision(world, message, revisionId, text) {
  const data = world.get(message, Message);
  assert.ok(data);
  const content = { role: data.role, parts: [{ text }] };
  world.add(message, Message, { ...data, content });

  const revision = world.spawn();
  world.add(revision, MessageRevision, {
    id: revisionId,
    content,
    createdAt: data.createdAt,
    reason: 'created'
  });
  const currentLink = world.spawn();
  world.add(currentLink, MessageCurrentRevisionLink, {
    id: `current-${revisionId}`,
    message,
    revision
  });
  return revision;
}

function createDispatchFixture() {
  const world = new MapWorld();
  world.setResource(ToolSchemasKey, []);
  world.setResource(ToolDefinitionsKey, []);

  const conversation = addConversation(world);
  const run = world.spawn();
  const beforeBoundary = addMessage(world, conversation, 'before-boundary', 200, 'model');
  const afterBoundary = addMessage(world, conversation, 'after-boundary', 300, 'user');
  const modelMessage = addMessage(world, conversation, 'current-model', 500, 'model', 'streaming');

  addCurrentMessageRevision(world, beforeBoundary, 'revision-before-boundary', 'x'.repeat(20_000));
  addCurrentMessageRevision(world, afterBoundary, 'revision-after-boundary', '继续');
  addCurrentMessageRevision(world, modelMessage, 'revision-current-model', '');

  const invocation = world.spawn();
  world.add(invocation, LlmInvocation, {
    id: 'dispatch-invocation',
    requestId: 'dispatch-request',
    status: 'pending',
    createdAt: 1,
    settings: {
      providerConfigId: 'provider-1',
      providerConfigName: '测试渠道',
      provider: 'openai-responses',
      modelId: 'test-model',
      contextWindowTokens: 100_000,
      compressionMethodKind: 'openai_responses_compact',
      compressionTrigger: {
        mode: 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: 1,
        preserveLatestMessages: 1
      }
    }
  });

  const request = world.spawn();
  world.add(request, LlmRequest, {
    id: 'dispatch-request',
    run,
    conversation,
    modelMessage,
    invocation
  });

  return { world, conversation, run, request, beforeBoundary, afterBoundary, modelMessage };
}

function createImmediateCommandSink(world) {
  const effects = [];
  const events = [];
  return {
    effects,
    events,
    cmd: {
      spawn: () => world.spawn(),
      despawn: (entity) => world.despawn(entity),
      add: (entity, component, value) => world.add(entity, component, value),
      remove: (entity, component) => world.remove(entity, component),
      setResource: (key, value) => world.setResource(key, value),
      enqueue: (event) => events.push(event),
      effect: (effect) => effects.push(effect)
    }
  };
}

function runDispatchWave(world) {
  const output = createImmediateCommandSink(world);
  LlmDispatchSystem.run({ world, cmd: output.cmd, events: [] });
  return output;
}

function llmStartEffects(output) {
  return output.effects.filter((effect) => effect.kind === 'llm.start');
}

function recordedInputRevisionIds(world) {
  return world
    .query(AgentRunInputRevision)
    .map((entity) => world.get(entity, AgentRunInputRevision))
    .filter(Boolean)
    .map((input) => world.get(input.revision, MessageRevision)?.id)
    .filter(Boolean)
    .sort();
}

for (const scenario of [
  {
    name: 'provider-native compact',
    kind: 'provider_native',
    settingsSnapshot: { provider: 'openai-responses', compressionMethodKind: 'openai_responses_compact' }
  },
  {
    name: 'summary fallback compact',
    kind: 'provider_neutral_summary',
    settingsSnapshot: undefined
  },
  {
    name: 'anchorSeq fallback compact',
    kind: 'provider_neutral_summary',
    settingsSnapshot: undefined,
    anchorOnly: true
  }
]) {
  test(`${scenario.name} 只记录压缩边界之后实际回放的消息`, () => {
    const world = new MapWorld();
    const conversation = addConversation(world);
    const run = world.spawn();
    const before = addMessage(world, conversation, 'before-boundary', 100);
    const atBoundary = addMessage(world, conversation, 'at-boundary', 200, 'model');
    const after = addMessage(world, conversation, 'after-boundary', 300);
    const runScopedAfter = addMessage(world, conversation, 'run-scoped-after', 400, 'model');
    const modelMessage = addMessage(world, conversation, 'current-model', 500, 'model', 'streaming');
    linkMessageToRun(world, before, run, 'link-before');
    linkMessageToRun(world, atBoundary, run, 'link-at');
    linkMessageToRun(world, runScopedAfter, run, 'link-after');
    addCompleteCompression(world, conversation, scenario.kind, scenario.anchorOnly === true);

    const input = {
      run,
      conversation,
      modelMessage,
      policy: { id: 'full-policy', historyMode: 'full' },
      settingsSnapshot: scenario.settingsSnapshot
    };
    const selected = selectRunContextMessageEntities(world, input);
    const contents = buildRunContextContents(world, input);
    const rawMessageTexts = contents
      .flatMap((content) => content.parts)
      .map((part) => part.text)
      .filter((text) => text && text !== 'compacted context');

    assert.deepEqual(new Set(selectedMessageIds(world, selected)), new Set(['after-boundary', 'run-scoped-after']));
    assert.deepEqual(new Set(rawMessageTexts), new Set(selectedMessageIds(world, selected)));
    assert.ok(!selected.includes(before));
    assert.ok(!selected.includes(atBoundary));
    assert.ok(selected.includes(after));
    assert.ok(selected.includes(runScopedAfter));
  });
}

test('无压缩时仍记录 history policy 与 run-scoped 实际选择的消息', () => {
  const world = new MapWorld();
  const conversation = addConversation(world);
  const run = world.spawn();
  const runScopedOld = addMessage(world, conversation, 'run-scoped-old', 100);
  addMessage(world, conversation, 'history-middle', 200, 'model');
  const historyLast = addMessage(world, conversation, 'history-last', 300);
  const modelMessage = addMessage(world, conversation, 'current-model', 400, 'model', 'streaming');
  linkMessageToRun(world, runScopedOld, run, 'link-run-scoped-old');

  const input = {
    run,
    conversation,
    modelMessage,
    policy: { id: 'last-one-policy', historyMode: 'last_n', lastN: 1 }
  };
  const selected = selectRunContextMessageEntities(world, input);
  const contentTexts = buildRunContextContents(world, input)
    .flatMap((content) => content.parts)
    .map((part) => part.text)
    .filter(Boolean);

  assert.deepEqual(selectedMessageIds(world, selected), ['run-scoped-old', world.get(historyLast, Message).id]);
  assert.deepEqual(contentTexts, selectedMessageIds(world, selected));
});

test('首次预派发压缩只 enqueue compression，不记录尚未发送的输入 revision', () => {
  const fixture = createDispatchFixture();

  const first = runDispatchWave(fixture.world);

  assert.equal(llmStartEffects(first).length, 0);
  assert.equal(first.events.length, 1);
  assert.equal(fixture.world.has(fixture.request, LlmRequestPreDispatchCompressionAttempt), true);
  assert.deepEqual(recordedInputRevisionIds(fixture.world), []);
});

test('预压缩完成后只记录 compact 边界后的真实消息并发起 llm.start', () => {
  const fixture = createDispatchFixture();

  const first = runDispatchWave(fixture.world);
  assert.equal(llmStartEffects(first).length, 0);
  assert.deepEqual(recordedInputRevisionIds(fixture.world), []);

  addCompleteCompression(fixture.world, fixture.conversation, 'provider_native');
  const second = runDispatchWave(fixture.world);
  const startEffects = llmStartEffects(second);

  assert.equal(startEffects.length, 1);
  assert.deepEqual(recordedInputRevisionIds(fixture.world), ['revision-after-boundary']);
  assert.equal(fixture.world.query(RunCompressionBlockLink).length, 1);
  assert.equal(startEffects[0].request.contents.some((content) =>
    content.parts.some((part) => part.text === '继续')), true);
  assert.equal(startEffects[0].request.contents.some((content) =>
    content.parts.some((part) => part.text === 'x'.repeat(20_000))), false);
});

test('预压缩 attempt 未产出 block 时下一轮放行原始输入并记录实际 revisions', () => {
  const fixture = createDispatchFixture();

  const first = runDispatchWave(fixture.world);
  assert.equal(llmStartEffects(first).length, 0);
  assert.equal(first.events.length, 1);
  assert.deepEqual(recordedInputRevisionIds(fixture.world), []);

  const second = runDispatchWave(fixture.world);

  assert.equal(second.events.length, 0);
  assert.equal(llmStartEffects(second).length, 1);
  assert.deepEqual(recordedInputRevisionIds(fixture.world), [
    'revision-after-boundary',
    'revision-before-boundary'
  ]);
  assert.equal(fixture.world.query(RunCompressionBlockLink).length, 0);
});

test('conversation client stream 不投影后端输入 revision 审计关系', () => {
  const state = createEmptyClientState();
  state.conversations.push({ id: 'conversation-1', title: '测试会话', visibility: 'visible' });
  state.agentRuns.push({ id: 'run-1', kind: 'main', status: 'running', createdAt: 1, updatedAt: 1 });
  state.agentRunTargetLinks.push({
    id: 'target-1',
    runId: 'run-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    role: 'primary',
    createdAt: 1,
    updatedAt: 1
  });
  for (let index = 0; index < 4_000; index += 1) {
    state.agentRunInputRevisions.push({
      id: `input-${index}`,
      runId: 'run-1',
      conversationId: 'conversation-1',
      revisionId: `revision-${index}`
    });
  }

  const projected = projectConversationClientState(state, 'conversation-1');

  assert.deepEqual(projected.agentRuns.map((run) => run.id), ['run-1']);
  assert.equal(projected.agentRunInputRevisions.length, 0);
});
