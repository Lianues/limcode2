const assert = require('node:assert/strict');
const test = require('node:test');

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Conversation } = require('../dist/extension/backend/world/modules/chat/components.js');
const { materializeUserInputMessage } = require('../dist/extension/backend/world/modules/chat/userInputMaterialization.js');
const {
  CheckpointBarrier,
  CheckpointPolicy,
  CheckpointPolicyScopeLink
} = require('../dist/extension/backend/world/modules/checkpoint/components.js');
const { requestCheckpointBarrierIfEnabled } = require('../dist/extension/backend/world/modules/checkpoint/barriers.js');
const { normalizeCheckpointPolicy } = require('../dist/extension/backend/world/modules/checkpoint/policy.js');

function createImmediateCommand(world) {
  const events = [];
  const effects = [];
  return {
    events,
    effects,
    spawn: () => world.spawn(),
    despawn: (entity) => world.despawn(entity),
    add: (entity, component, value) => world.add(entity, component, value),
    remove: (entity, component) => world.remove(entity, component),
    setResource: (key, value) => world.setResource(key, value),
    enqueue: (event) => events.push(event),
    effect: (effect) => effects.push(effect)
  };
}

function createConversationWithGlobalPolicy(policyInput) {
  const world = new MapWorld();
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-checkpoint-policy' });

  const policyEntity = world.spawn();
  world.add(policyEntity, CheckpointPolicy, normalizeCheckpointPolicy({
    id: 'checkpoint-policy-global-test',
    name: '测试 Checkpoint Policy',
    ...policyInput,
    createdAt: 1,
    updatedAt: 1
  }));

  const link = world.spawn();
  world.add(link, CheckpointPolicyScopeLink, {
    id: 'checkpoint-policy-link-global-test',
    scopeKind: 'global',
    checkpointPolicy: policyEntity,
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });

  return { world, conversation, policyEntity };
}

test('Checkpoint Policy 整体关闭时，新消息不创建 barrier 且不发送自动 Requested', () => {
  const { world, conversation } = createConversationWithGlobalPolicy({ enabled: false });
  const cmd = createImmediateCommand(world);

  materializeUserInputMessage(
    world,
    cmd,
    conversation,
    'conversation-checkpoint-policy',
    { role: 'user', parts: [{ text: 'checkpoint disabled' }] }
  );

  assert.equal(world.query(CheckpointBarrier).length, 0);
  assert.deepEqual(cmd.events, []);
});

test('仅开启 userMessageBefore 时，新消息只创建对应 barrier 和 Requested', () => {
  const { world, conversation } = createConversationWithGlobalPolicy({
    enabled: true,
    triggers: {
      conversationInitial: false,
      userMessageBefore: true,
      userMessageAfter: false,
      llmResponseBefore: false,
      llmResponseAfter: false,
      agentRunCompletedBefore: false,
      agentRunCompletedAfter: false,
      manual: true
    }
  });
  const cmd = createImmediateCommand(world);

  materializeUserInputMessage(
    world,
    cmd,
    conversation,
    'conversation-checkpoint-policy',
    { role: 'user', parts: [{ text: 'checkpoint enabled' }] }
  );

  const barriers = world.query(CheckpointBarrier).map((entity) => world.get(entity, CheckpointBarrier));
  assert.equal(barriers.length, 1);
  assert.equal(barriers[0].trigger, 'user_message_before');
  assert.equal(cmd.events.length, 1);
  assert.equal(cmd.events[0].type, 'checkpoint:requested');
  assert.equal(cmd.events[0].payload.trigger, 'user_message_before');
});

test('llmResponseBefore 关闭时 helper 原子跳过 barrier 和 Requested，开启时两者同时创建', () => {
  const { world, conversation, policyEntity } = createConversationWithGlobalPolicy({
    enabled: true,
    triggers: { llmResponseBefore: false }
  });
  const disabledCmd = createImmediateCommand(world);

  const disabled = requestCheckpointBarrierIfEnabled(world, disabledCmd, {
    barrier: {
      checkpointId: 'checkpoint-llm-disabled',
      conversation,
      trigger: 'llm_response_before',
      targetKind: 'llm_request',
      targetLlmRequestId: 'llm-request-disabled'
    },
    request: {
      conversationId: 'conversation-checkpoint-policy',
      floorMessageId: 'model-message-disabled',
      anchorPosition: 'before'
    }
  });
  assert.deepEqual(disabled, { requested: false, reason: 'trigger_disabled' });
  assert.equal(world.query(CheckpointBarrier).length, 0);
  assert.deepEqual(disabledCmd.events, []);

  world.add(policyEntity, CheckpointPolicy, normalizeCheckpointPolicy({
    id: 'checkpoint-policy-global-test',
    name: '测试 Checkpoint Policy',
    enabled: true,
    triggers: { llmResponseBefore: true },
    createdAt: 1,
    updatedAt: 2
  }));
  const enabledCmd = createImmediateCommand(world);
  const enabled = requestCheckpointBarrierIfEnabled(world, enabledCmd, {
    barrier: {
      checkpointId: 'checkpoint-llm-enabled',
      conversation,
      trigger: 'llm_response_before',
      targetKind: 'llm_request',
      targetLlmRequestId: 'llm-request-enabled'
    },
    request: {
      conversationId: 'conversation-checkpoint-policy',
      floorMessageId: 'model-message-enabled',
      anchorPosition: 'before'
    }
  });

  assert.equal(enabled.requested, true);
  assert.equal(world.query(CheckpointBarrier).length, 1);
  assert.equal(enabledCmd.events.length, 1);
  assert.equal(enabledCmd.events[0].payload.trigger, 'llm_response_before');
  assert.equal(enabledCmd.events[0].payload.checkpointId, 'checkpoint-llm-enabled');
});
