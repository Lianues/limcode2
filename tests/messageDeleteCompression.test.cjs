const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const {
  Conversation,
  Message,
  PartOf
} = require('../dist/extension/backend/world/modules/chat/components.js');
const {
  CompressionBlock,
  CompressionBlockSourceLink,
  CompressionContextVariant
} = require('../dist/extension/backend/world/modules/compression/components.js');
const { deleteMessagesFromIndex } = require('../dist/extension/backend/world/modules/chat/systems/MessageDeleteSystem.js');

function addMessage(world, conversation, id, seq, role = 'model') {
  const entity = world.spawn();
  world.add(entity, Message, {
    id,
    role,
    content: { role, parts: [{ text: id }] },
    status: 'complete',
    seq,
    createdAt: seq
  });
  world.add(entity, PartOf, { parent: conversation });
  return entity;
}

function addCompressionBlock(world, conversation, input) {
  const block = world.spawn();
  world.add(block, CompressionBlock, {
    id: input.id,
    conversation,
    title: '自动上下文压缩',
    status: input.status ?? 'complete',
    trigger: 'auto',
    methodKind: 'openai_responses_compact',
    anchorMessageId: input.anchorMessageId,
    anchorSeq: input.endSeq,
    startSeq: input.startSeq,
    endSeq: input.endSeq,
    sourceMessageCount: 1,
    createdAt: input.endSeq,
    updatedAt: input.endSeq
  });
  return block;
}

function addMessageSourceLink(world, block, message, sourceId, id) {
  const link = world.spawn();
  world.add(link, CompressionBlockSourceLink, {
    id,
    block,
    source: message,
    sourceKind: 'message',
    sourceId,
    role: 'anchor',
    order: 0,
    createdAt: 1,
    updatedAt: 1
  });
  return link;
}

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

test('删除压缩来源结束点之后的中断消息时保留前序压缩块', () => {
  const world = new MapWorld();
  const effects = [];
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-1', title: '测试', visibility: 'visible' });

  const summarized = addMessage(world, conversation, 'summarized', 100_000);
  const user = addMessage(world, conversation, 'continue', 200_000, 'user');
  const interrupted = addMessage(world, conversation, 'interrupted', 300_000);
  const block = addCompressionBlock(world, conversation, {
    id: 'compression-before-interrupted',
    anchorMessageId: 'summarized',
    startSeq: 100_000,
    endSeq: 100_000
  });
  const sourceLink = addMessageSourceLink(world, block, summarized, 'summarized', 'source-before-interrupted');
  const variant = world.spawn();
  world.add(variant, CompressionContextVariant, {
    id: 'variant-before-interrupted',
    block,
    kind: 'provider_native',
    contents: [{ role: 'user', parts: [{ text: 'compacted' }] }],
    createdAt: 1,
    updatedAt: 1
  });

  deleteMessagesFromIndex(world, commandSink(world, effects), [summarized, user, interrupted], 2);

  assert.equal(world.has(interrupted, Message), false);
  assert.equal(world.has(block, CompressionBlock), true);
  assert.equal(world.has(sourceLink, CompressionBlockSourceLink), true);
  assert.equal(world.has(variant, CompressionContextVariant), true);
  assert.deepEqual(effects, []);
});

test('删除边界进入压缩来源区间时删除压缩块及其依赖块', () => {
  const world = new MapWorld();
  const effects = [];
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id: 'conversation-2', title: '测试', visibility: 'visible' });

  const first = addMessage(world, conversation, 'first', 100_000, 'user');
  const source = addMessage(world, conversation, 'source', 200_000);
  const later = addMessage(world, conversation, 'later', 300_000, 'user');
  const block = addCompressionBlock(world, conversation, {
    id: 'compression-affected',
    anchorMessageId: 'source',
    startSeq: 100_000,
    endSeq: 200_000,
    status: 'running'
  });
  addMessageSourceLink(world, block, source, 'source', 'source-affected');

  const dependent = addCompressionBlock(world, conversation, {
    id: 'compression-dependent',
    anchorMessageId: 'later',
    startSeq: 100_000,
    endSeq: 300_000
  });
  const retainedLink = world.spawn();
  world.add(retainedLink, CompressionBlockSourceLink, {
    id: 'retained-link',
    block: dependent,
    source: block,
    sourceKind: 'compressionBlock',
    sourceId: 'compression-affected',
    role: 'retained',
    order: 0,
    createdAt: 1,
    updatedAt: 1
  });

  deleteMessagesFromIndex(world, commandSink(world, effects), [first, source, later], 1);

  assert.equal(world.has(first, Message), true);
  assert.equal(world.has(source, Message), false);
  assert.equal(world.has(later, Message), false);
  assert.equal(world.has(block, CompressionBlock), false);
  assert.equal(world.has(dependent, CompressionBlock), false);
  assert.equal(world.has(retainedLink, CompressionBlockSourceLink), false);
  assert.deepEqual(effects, [{ kind: 'llm.abort', requestId: 'compact-compression-affected' }]);
});
