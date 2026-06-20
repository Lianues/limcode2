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

function checkpoint(id, createdAt, patch = {}) {
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
    updatedAt: createdAt,
    ...patch
  };
}

function initialCheckpoint(id, createdAt) {
  return checkpoint(id, createdAt, { trigger: 'conversation_initial' });
}

function skippedCheckpoint(id, createdAt) {
  return {
    ...checkpoint(id, createdAt),
    status: 'skipped',
    skipReason: 'no_changes',
    message: '项目内容没有变化，未创建新存档点。'
  };
}

function anchor(id, checkpointId, floorMessageId, position, order, extra = {}) {
  return {
    id,
    conversationId: 'conversation-1',
    checkpointId,
    floorMessageId,
    position,
    order,
    createdAt: order,
    updatedAt: order,
    ...extra
  };
}

function testCheckpointAttachesToMessageFloorWithoutTakingFloorNumber() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [checkpoint('checkpoint-1', 10)],
    checkpointAnchors: [anchor('anchor-1', 'checkpoint-1', 'message-1', 'after', 10)]
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
    checkpointAnchors: [anchor('anchor-1', 'checkpoint-1', 'message-2', 'before', 10)]
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'checkpoint', 'message']);
  assert.equal(rows[1].floorMessageId, 'message-2');
  assert.equal(rows[1].position, 'before');
  assert.equal(rows[2].messageFloorNumber, 2);
}

function testAdjacentNoChangeCheckpointsDoNotCollapseAtAdjacentGap() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [skippedCheckpoint('checkpoint-after-current', 10), skippedCheckpoint('checkpoint-before-next', 20)],
    checkpointAnchors: [
      anchor('anchor-after-current', 'checkpoint-after-current', 'message-1', 'after', 10, { sourceToolCallId: 'tool-1' }),
      anchor('anchor-before-next', 'checkpoint-before-next', 'message-2', 'before', 20, { sourceToolCallId: 'tool-1' })
    ]
  });

  const checkpointRows = rows.filter((row) => row.kind === 'checkpoint');
  assert.equal(checkpointRows.length, 2);
  assert.equal(checkpointRows[0].checkpoint.id, 'checkpoint-after-current');
  assert.equal(checkpointRows[0].position, 'after');
  assert.equal(checkpointRows[1].checkpoint.id, 'checkpoint-before-next');
  assert.equal(checkpointRows[1].position, 'before');
}

function testAdjacentNoChangeCheckpointKeepsBothRowsEvenWithCreatedSnapshot() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [checkpoint('checkpoint-created', 10), skippedCheckpoint('checkpoint-no-change', 20)],
    checkpointAnchors: [
      anchor('anchor-created', 'checkpoint-created', 'message-1', 'after', 10),
      anchor('anchor-no-change', 'checkpoint-no-change', 'message-2', 'before', 20)
    ]
  });

  const checkpointRows = rows.filter((row) => row.kind === 'checkpoint');
  assert.equal(checkpointRows.length, 2);
  assert.equal(checkpointRows[0].checkpoint.id, 'checkpoint-created');
  assert.equal(checkpointRows[0].position, 'after');
  assert.equal(checkpointRows[1].checkpoint.id, 'checkpoint-no-change');
  assert.equal(checkpointRows[1].position, 'before');
}

function testAdjacentCheckpointsDoNotCollapseWhenContentChanged() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1), message('message-2', 2)],
    checkpoints: [skippedCheckpoint('checkpoint-no-change', 10), checkpoint('checkpoint-created', 20)],
    checkpointAnchors: [
      anchor('anchor-no-change', 'checkpoint-no-change', 'message-1', 'after', 10),
      anchor('anchor-created', 'checkpoint-created', 'message-2', 'before', 20)
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
      anchor('anchor-before', 'checkpoint-before', 'message-1', 'before', 10, { sourceToolCallId: 'tool-1' }),
      anchor('anchor-after', 'checkpoint-after', 'message-1', 'after', 20, { sourceToolCallId: 'tool-1' })
    ]
  });

  const checkpointRows = rows.filter((row) => row.kind === 'checkpoint');
  assert.equal(checkpointRows.length, 2);
  assert.equal(checkpointRows[0].checkpoint.id, 'checkpoint-before');
  assert.equal(checkpointRows[0].position, 'before');
  assert.equal(checkpointRows[1].checkpoint.id, 'checkpoint-after');
  assert.equal(checkpointRows[1].position, 'after');
}

function testUnanchoredInitialCheckpointRendersAtStart() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1)],
    checkpoints: [initialCheckpoint('checkpoint-initial', 0)],
    checkpointAnchors: []
  });

  assert.deepEqual(rows.map((row) => row.kind), ['checkpoint', 'message']);
  assert.equal(rows[0].checkpoint.id, 'checkpoint-initial');
  assert.equal(rows[0].position, 'start');
  assert.equal(rows[0].floorMessageId, undefined);
  assert.equal(rows[1].messageFloorNumber, 1);
}

function testUnanchoredNonInitialCheckpointDoesNotRenderAtStart() {
  const rows = buildConversationTimelineRows({
    messages: [message('message-1', 1)],
    checkpoints: [checkpoint('checkpoint-unbound-task-completed', 0, { trigger: 'agent_run_completed_after' })],
    checkpointAnchors: []
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message']);
  assert.equal(rows[0].messageFloorNumber, 1);
}

testCheckpointAttachesToMessageFloorWithoutTakingFloorNumber();
testCheckpointCanRenderBeforeMessageFloor();
testAdjacentNoChangeCheckpointsDoNotCollapseAtAdjacentGap();
testAdjacentNoChangeCheckpointKeepsBothRowsEvenWithCreatedSnapshot();
testAdjacentCheckpointsDoNotCollapseWhenContentChanged();
testDuplicateNoChangeToolCheckpointsDoNotCollapseAcrossFloor();
testUnanchoredInitialCheckpointRendersAtStart();
testUnanchoredNonInitialCheckpointDoesNotRenderAtStart();

console.log('conversation timeline tests passed');
