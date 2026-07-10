const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { forkConversationInWorld } = require('../dist/extension/backend/application/conversationFork.js');
const {
  Agent,
  AgentConversationLink,
  ConversationAgentSelection
} = require('../dist/extension/backend/world/modules/agent/components.js');
const {
  Conversation,
  ConversationBranchLink,
  ConversationOriginLink,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf
} = require('../dist/extension/backend/world/modules/chat/components.js');
const { spawnUserMessage } = require('../dist/extension/backend/world/modules/chat/bundles.js');
const {
  ConversationModeSelection,
  Mode
} = require('../dist/extension/backend/world/modules/mode/components.js');
const {
  ConversationProjectLink,
  ProjectContext
} = require('../dist/extension/backend/world/modules/project/components.js');
const {
  ToolCall,
  ToolCallEvent,
  ToolState
} = require('../dist/extension/backend/world/modules/tools/components.js');
const {
  ConversationWorkEnvironmentLink,
  WorkEnvironment
} = require('../dist/extension/backend/world/modules/workEnvironment/components.js');

function addMessage(world, conversation, input) {
  const entity = world.spawn();
  const content = { role: input.role, parts: input.parts };
  world.add(entity, Message, {
    id: input.id,
    role: input.role,
    ...(input.model ? { model: input.model } : {}),
    content,
    status: 'complete',
    seq: input.seq,
    createdAt: input.createdAt,
    ...(input.requestStartedAt !== undefined ? { requestStartedAt: input.requestStartedAt } : {}),
    ...(input.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: input.streamOutputDurationMs } : {})
  });
  world.add(entity, PartOf, { parent: conversation });
  const revision = world.spawn();
  world.add(revision, MessageRevision, {
    id: `revision-${input.id}`,
    content,
    createdAt: input.createdAt,
    reason: 'created'
  });
  world.add(revision, PartOf, { parent: entity });
  const current = world.spawn();
  world.add(current, MessageCurrentRevisionLink, {
    id: `current-${input.id}`,
    message: entity,
    revision
  });
  return { entity, revision };
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

test('fork 对话只复制目标楼层及之前的消息，并创建独立关系与工具快照', () => {
  const world = new MapWorld();
  const now = 9_000_000;

  const agent = world.spawn();
  world.add(agent, Agent, { id: 'agent-main', name: 'Main', source: 'builtin' });

  const source = world.spawn();
  world.add(source, Conversation, { id: 'source', title: '源对话', visibility: 'visible' });

  const agentLink = world.spawn();
  world.add(agentLink, AgentConversationLink, {
    id: 'acl-source',
    agent,
    conversation: source,
    role: 'default',
    createdAt: 1,
    updatedAt: 1
  });
  const agentSelection = world.spawn();
  world.add(agentSelection, ConversationAgentSelection, {
    id: 'agent-selection-source',
    conversation: source,
    agent,
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });

  const mode = world.spawn();
  world.add(mode, Mode, { id: 'mode-plan', name: 'Plan', source: 'user', createdAt: 1, updatedAt: 1 });
  const modeSelection = world.spawn();
  world.add(modeSelection, ConversationModeSelection, {
    id: 'mode-selection-source',
    conversation: source,
    scopeKind: 'mode',
    mode,
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });

  const project = world.spawn();
  world.add(project, ProjectContext, { id: 'project-1', kind: 'folder', uri: 'file:///repo', name: 'repo', createdAt: 1, updatedAt: 1 });
  const projectLink = world.spawn();
  world.add(projectLink, ConversationProjectLink, {
    id: 'project-link-source',
    conversation: source,
    projectContext: project,
    role: 'primary',
    createdAt: 1,
    updatedAt: 1
  });

  const workEnvironment = world.spawn();
  world.add(workEnvironment, WorkEnvironment, {
    id: 'work-env-1',
    kind: 'localFolder',
    name: 'repo',
    available: true,
    createdAt: 1,
    updatedAt: 1
  });
  const workEnvironmentLink = world.spawn();
  world.add(workEnvironmentLink, ConversationWorkEnvironmentLink, {
    id: 'work-env-link-source',
    conversation: source,
    workEnvironment,
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });

  const first = addMessage(world, source, {
    id: 'message-1',
    role: 'user',
    parts: [{ text: '第一条' }],
    seq: 100_000,
    createdAt: 100
  });
  const second = addMessage(world, source, {
    id: 'message-2',
    role: 'model',
    model: 'test-model',
    parts: [{ id: 'provider-call-1', functionCall: { name: 'read', args: { path: 'a.txt' } } }, { text: '第二条' }],
    seq: 200_000,
    createdAt: 200,
    requestStartedAt: 150,
    streamOutputDurationMs: 40
  });
  addMessage(world, source, {
    id: 'tool-response-1',
    role: 'user',
    parts: [{ id: 'provider-call-1', functionResponse: { name: 'read', response: { content: 'hello' } } }],
    seq: 250_000,
    createdAt: 250
  });
  addMessage(world, source, {
    id: 'message-3',
    role: 'user',
    parts: [{ text: '不应复制' }],
    seq: 300_000,
    createdAt: 300
  });

  const toolCall = world.spawn();
  world.add(toolCall, ToolCall, {
    id: 'tool-call-source',
    functionCallId: 'provider-call-1',
    name: 'read',
    argsJson: '{"path":"a.txt"}',
    createdAt: 180
  });
  world.add(toolCall, PartOf, { parent: second.entity });
  world.add(toolCall, ToolState, {
    status: 'success',
    updatedAt: 210,
    result: { content: 'hello' },
    durationMs: 30
  });
  const toolEvent = world.spawn();
  world.add(toolEvent, ToolCallEvent, {
    id: 'tool-event-source',
    toolCallId: 'tool-call-source',
    seq: 1,
    kind: 'completed',
    at: 210,
    status: 'success',
    payload: { ok: true }
  });
  world.add(toolEvent, PartOf, { parent: toolCall });

  const result = forkConversationInWorld(world, {
    sourceConversationId: 'source',
    throughMessageId: 'message-2',
    targetConversationId: 'forked',
    now
  });

  assert.equal(result.conversationId, 'forked');
  assert.equal(result.sourceMessage, second.entity);
  // 工具响应是当前可见楼层的隐藏上下文消息，也应一起复制，避免留下未配对的 functionCall。
  assert.equal(result.copiedMessageCount, 3);

  const targetMessages = world.query(Message, PartOf)
    .filter((entity) => world.get(entity, PartOf).parent === result.conversation)
    .sort((left, right) => world.get(left, Message).seq - world.get(right, Message).seq);
  assert.equal(targetMessages.length, 3);
  assert.deepEqual(targetMessages.map((entity) => world.get(entity, Message).content.parts), [
    [{ text: '第一条' }],
    [{ id: 'provider-call-1', functionCall: { name: 'read', args: { path: 'a.txt' } } }, { text: '第二条' }],
    [{ id: 'provider-call-1', functionResponse: { name: 'read', response: { content: 'hello' } } }]
  ]);
  assert.notEqual(world.get(targetMessages[0], Message).id, 'message-1');
  assert.notStrictEqual(world.get(targetMessages[0], Message).content, world.get(first.entity, Message).content);
  assert.equal(world.get(targetMessages[1], Message).createdAt, 200);
  assert.equal(world.get(targetMessages[1], Message).requestStartedAt, 150);
  assert.equal(world.get(targetMessages[1], Message).streamOutputDurationMs, 40);

  const branch = world.query(ConversationBranchLink).map((entity) => world.get(entity, ConversationBranchLink))[0];
  assert.equal(branch.sourceConversation, source);
  assert.equal(branch.targetConversation, result.conversation);
  assert.equal(branch.sourceRevision, second.revision);
  assert.equal(branch.kind, 'fork');

  const origin = world.query(ConversationOriginLink).map((entity) => world.get(entity, ConversationOriginLink))[0];
  assert.equal(origin.conversation, result.conversation);
  assert.equal(origin.sourceConversation, undefined);
  assert.equal(origin.sourceConversationId, undefined);
  assert.equal(origin.sourceMessage, undefined);
  assert.equal(origin.sourceMessageId, undefined);

  const targetAgentLinks = world.query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link) => link.conversation === result.conversation);
  assert.equal(targetAgentLinks.length, 1);
  assert.equal(targetAgentLinks[0].agent, agent);
  assert.equal(targetAgentLinks[0].role, 'default');
  const targetSelection = world.query(ConversationAgentSelection)
    .map((entity) => world.get(entity, ConversationAgentSelection))
    .find((selection) => selection.conversation === result.conversation);
  assert.equal(targetSelection.agent, agent);

  const targetMode = world.query(ConversationModeSelection)
    .map((entity) => world.get(entity, ConversationModeSelection))
    .find((selection) => selection.conversation === result.conversation);
  assert.equal(targetMode.scopeKind, 'mode');
  assert.equal(targetMode.mode, mode);
  assert.equal(world.query(ConversationProjectLink).filter((entity) => world.get(entity, ConversationProjectLink).conversation === result.conversation).length, 1);
  assert.equal(world.query(ConversationWorkEnvironmentLink).filter((entity) => world.get(entity, ConversationWorkEnvironmentLink).conversation === result.conversation).length, 1);

  const targetToolCallEntity = world.query(ToolCall, ToolState, PartOf)
    .find((entity) => world.get(entity, PartOf).parent === targetMessages[1]);
  assert.ok(targetToolCallEntity);
  const targetToolCall = world.get(targetToolCallEntity, ToolCall);
  const targetToolState = world.get(targetToolCallEntity, ToolState);
  assert.notEqual(targetToolCall.id, 'tool-call-source');
  assert.equal(targetToolCall.functionCallId, 'provider-call-1');
  assert.deepEqual(targetToolState.result, { content: 'hello' });
  assert.equal(targetToolState.status, 'success');
  const targetEvents = world.query(ToolCallEvent, PartOf)
    .filter((entity) => world.get(entity, PartOf).parent === targetToolCallEntity)
    .map((entity) => world.get(entity, ToolCallEvent));
  assert.equal(targetEvents.length, 1);
  assert.equal(targetEvents[0].toolCallId, targetToolCall.id);

  const appended = spawnUserMessage(commandSink(world), result.conversation, '继续');
  assert.ok(world.get(appended, Message).seq > 250_000);
});
