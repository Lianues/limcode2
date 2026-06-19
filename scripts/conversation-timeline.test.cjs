const assert = require('node:assert/strict');

const { buildConversationTimelineRows } = require('../dist/extension/shared/conversationTimeline');

function message(id, seq) {
  return {
    id,
    conversationId: 'conversation-1',
    role: 'user',
    content: { role: 'user', parts: [{ text: id }] },
    status: 'complete',
    createdAt: seq,
    seq
  };
}

function checkpoint(id, createdAt) {
  return {
    id,
    conversationId: 'conversation-1',
    projectContextId: 'project-1',
    shadowRepositoryId: 'shadow-1',
    trigger: 'user_message_after',
    status: 'created',
    projectUri: 'file:///workspace',
    projectDisplayPath: 'workspace',
    createdAt,
    updatedAt: createdAt
  };
}

function skippedCheckpoint(id, createdAt) {
  return {
    ...checkpoint(id, createdAt),
    status: 'skipped',
    skipReason: 'no_changes',
    message: '项目内容没有变化，未创建新存档点。'
  };
}

function testCheckpointAttachesToMessageFloorWithoutTakingFloorNumber() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [checkpoint('checkpoint-1', 10)],
    checkpointAnchors: [
      {
        id: 'anchor-1',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-1',
        floorMessageId: 'message-1',
        position: 'after',
        order: 0,
        createdAt: 10,
        updatedAt: 10
      }
    ]
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'checkpoint', 'message']);
  assert.equal(rows[0].messageFloorNumber, 1);
  assert.equal(rows[1].floorMessageId, 'message-1');
  assert.equal(rows[1].position, 'after');
  assert.equal(rows[2].messageFloorNumber, 2);
}

function testCheckpointCanRenderBeforeMessageFloor() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [checkpoint('checkpoint-1', 10)],
    checkpointAnchors: [
      {
        id: 'anchor-1',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-1',
        floorMessageId: 'message-2',
        position: 'before',
        order: 0,
        createdAt: 10,
        updatedAt: 10
      }
    ]
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'checkpoint', 'message']);
  assert.equal(rows[1].floorMessageId, 'message-2');
  assert.equal(rows[1].position, 'before');
  assert.equal(rows[2].messageFloorNumber, 2);
}

function testDuplicateNoChangeToolCheckpointsCollapseAtAdjacentGap() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [skippedCheckpoint('checkpoint-after-current', 10), skippedCheckpoint('checkpoint-before-next', 20)],
    checkpointAnchors: [
      {
        id: 'anchor-after-current',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-after-current',
        floorMessageId: 'message-1',
        position: 'after',
        order: 10,
        sourceToolCallId: 'tool-1',
        createdAt: 10,
        updatedAt: 10
      },
      {
        id: 'anchor-before-next',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-before-next',
        floorMessageId: 'message-2',
        position: 'before',
        order: 20,
        sourceToolCallId: 'tool-1',
        createdAt: 20,
        updatedAt: 20
      }
    ]
  });

  const checkpointRows = rows.filter((row) => row.kind === 'checkpoint');
  assert.equal(checkpointRows.length, 1);
  assert.equal(checkpointRows[0].checkpoint.id, 'checkpoint-before-next');
  assert.equal(checkpointRows[0].floorMessageId, 'message-2');
  assert.equal(checkpointRows[0].position, 'before');
}

function testAdjacentNoChangeCheckpointKeepsCreatedSnapshot() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [checkpoint('checkpoint-created', 10), skippedCheckpoint('checkpoint-no-change', 20)],
    checkpointAnchors: [
      {
        id: 'anchor-created',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-created',
        floorMessageId: 'message-1',
        position: 'after',
        order: 10,
        createdAt: 10,
        updatedAt: 10
      },
      {
        id: 'anchor-no-change',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-no-change',
        floorMessageId: 'message-2',
        position: 'before',
        order: 20,
        createdAt: 20,
        updatedAt: 20
      }
    ]
  });

  const checkpointRows = rows.filter((row) => row.kind === 'checkpoint');
  assert.equal(checkpointRows.length, 1);
  assert.equal(checkpointRows[0].checkpoint.id, 'checkpoint-created');
  assert.equal(checkpointRows[0].position, 'after');
}

function testAdjacentCheckpointsDoNotCollapseWhenContentChanged() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [skippedCheckpoint('checkpoint-no-change', 10), checkpoint('checkpoint-created', 20)],
    checkpointAnchors: [
      {
        id: 'anchor-no-change',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-no-change',
        floorMessageId: 'message-1',
        position: 'after',
        order: 10,
        createdAt: 10,
        updatedAt: 10
      },
      {
        id: 'anchor-created',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-created',
        floorMessageId: 'message-2',
        position: 'before',
        order: 20,
        createdAt: 20,
        updatedAt: 20
      }
    ]
  });

  const checkpointRows = rows.filter((row) => row.kind === 'checkpoint');
  assert.equal(checkpointRows.length, 2);
  assert.equal(checkpointRows[0].checkpoint.id, 'checkpoint-no-change');
  assert.equal(checkpointRows[0].position, 'after');
  assert.equal(checkpointRows[1].checkpoint.id, 'checkpoint-created');
  assert.equal(checkpointRows[1].position, 'before');
}

function testDuplicateNoChangeToolCheckpointsDoNotCollapseAcrossFloor() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1)],
    checkpoints: [skippedCheckpoint('checkpoint-before', 10), skippedCheckpoint('checkpoint-after', 20)],
    checkpointAnchors: [
      {
        id: 'anchor-before',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-before',
        floorMessageId: 'message-1',
        position: 'before',
        order: 10,
        sourceToolCallId: 'tool-1',
        createdAt: 10,
        updatedAt: 10
      },
      {
        id: 'anchor-after',
        conversationId: 'conversation-1',
        checkpointId: 'checkpoint-after',
        floorMessageId: 'message-1',
        position: 'after',
        order: 20,
        sourceToolCallId: 'tool-1',
        createdAt: 20,
        updatedAt: 20
      }
    ]
  });

  const checkpointRows = rows.filter((row) => row.kind === 'checkpoint');
  assert.equal(checkpointRows.length, 2);
  assert.equal(checkpointRows[0].checkpoint.id, 'checkpoint-before');
  assert.equal(checkpointRows[0].position, 'before');
  assert.equal(checkpointRows[1].checkpoint.id, 'checkpoint-after');
  assert.equal(checkpointRows[1].position, 'after');
}

testCheckpointAttachesToMessageFloorWithoutTakingFloorNumber();
testCheckpointCanRenderBeforeMessageFloor();
testDuplicateNoChangeToolCheckpointsCollapseAtAdjacentGap();
testAdjacentNoChangeCheckpointKeepsCreatedSnapshot();
testAdjacentCheckpointsDoNotCollapseWhenContentChanged();
testDuplicateNoChangeToolCheckpointsDoNotCollapseAcrossFloor();

console.log('conversation timeline tests passed');
