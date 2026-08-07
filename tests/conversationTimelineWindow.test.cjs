const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT,
  classifyConversationStreamMessageRemovals,
  conversationTimelineStateForMessageIds,
  createConversationTimelineSeqWindow,
  seqInConversationTimelineWindow,
  timelineHasNewerChunks,
  timelineHasOlderChunks
} = require('../dist/extension/shared/conversationTimelineWindow.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

function message(seq) {
  return {
    id: `m-${seq}`,
    conversationId: 'conv-window',
    role: seq % 2 === 0 ? 'model' : 'user',
    content: { parts: [{ text: `message ${seq}` }] },
    status: 'complete',
    seq,
    createdAt: seq
  };
}

function chunk(index, startSeq, endSeq) {
  return {
    id: String(index).padStart(6, '0'),
    index,
    startSeq,
    endSeq,
    messageCount: endSeq - startSeq + 1,
    messageOffsetStart: startSeq,
    messageOffsetEnd: endSeq,
    toolCallCount: 0,
    toolCallEventCount: 0
  };
}

test('timeline window 使用显式 tailAttached，加载 older 不会裁掉实时尾部', () => {
  const chunks = [chunk(6, 601, 700), chunk(7, 701, 800), chunk(8, 801, 900), chunk(9, 901, 1000)];
  const attached = createConversationTimelineSeqWindow(chunks, true);
  const detached = createConversationTimelineSeqWindow(chunks, false);

  assert.equal(seqInConversationTimelineWindow(650, attached), true);
  assert.equal(seqInConversationTimelineWindow(1050, attached), true);
  assert.equal(seqInConversationTimelineWindow(1050, detached), false);
  assert.equal(timelineHasOlderChunks(chunks), true);
  assert.equal(timelineHasNewerChunks(chunks, 11), true);
});

test('240 条 conversation stream 前移只标记窗口淘汰，不误判为领域删除', () => {
  const previous = Array.from({ length: CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT }, (_, index) => message(index + 1));
  const next = Array.from({ length: CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT }, (_, index) => message(index + 2));
  const authoritative = [...previous, message(CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT + 1)];
  const result = classifyConversationStreamMessageRemovals(previous, next, authoritative);

  assert.deepEqual([...result.evictedMessageIds], ['m-1']);
  assert.deepEqual([...result.semanticMessageIds], []);
});

test('真实删除导致窗口缩短时不会被当作 stream 淘汰', () => {
  const previous = Array.from({ length: CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT }, (_, index) => message(index + 1));
  const next = previous.slice(0, 120);
  const result = classifyConversationStreamMessageRemovals(previous, next, next);

  assert.equal(result.evictedMessageIds.size, 0);
  assert.equal(result.semanticMessageIds.size, 120);
  assert.equal(result.semanticMessageIds.has('m-240'), true);
});

test('窗口淘汰消息的 timeline 关系闭包可被完整保留', () => {
  const state = createEmptyClientState();
  state.messages.push(message(1), message(2));
  state.messageRevisions.push({ id: 'revision-1', conversationId: 'conv-window', messageId: 'm-1', content: { parts: [] }, createdAt: 1 });
  state.messageCurrentRevisionLinks.push({ id: 'current-revision-1', messageId: 'm-1', revisionId: 'revision-1' });
  state.toolCalls.push({ id: 'tool-1', messageId: 'm-1', name: 'demo', args: '{}', status: 'success', createdAt: 1, updatedAt: 1 });
  state.toolCallEvents.push({ id: 'event-1', toolCallId: 'tool-1', seq: 1, createdAt: 1, kind: 'result' });
  state.messageRunLinks.push({ id: 'message-run-1', messageId: 'm-1', runId: 'run-1', role: 'model' });
  state.agentRuns.push({ id: 'run-1', status: 'completed', createdAt: 1, updatedAt: 1 });

  const retained = conversationTimelineStateForMessageIds(state, new Set(['m-1']));
  assert.deepEqual(retained.messages.map((item) => item.id), ['m-1']);
  assert.deepEqual(retained.messageRevisions.map((item) => item.id), ['revision-1']);
  assert.deepEqual(retained.toolCalls.map((item) => item.id), ['tool-1']);
  assert.deepEqual(retained.toolCallEvents.map((item) => item.id), ['event-1']);
  assert.deepEqual(retained.messageRunLinks.map((item) => item.id), ['message-run-1']);
  assert.deepEqual(retained.agentRuns.map((item) => item.id), ['run-1']);
});
