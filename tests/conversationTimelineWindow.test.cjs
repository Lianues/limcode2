const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT,
  classifyConversationStreamMessageRemovals,
  conversationTimelineCommitCanApply,
  conversationTimelinePrependAnchorCanRestore,
  conversationTimelineStateForMessageIds,
  createConversationTimelineSeqWindow,
  pruneConversationTimelineStateToWindow,
  seqInConversationTimelineWindow,
  timelineHasNewerChunks,
  timelineHasOlderChunks
} = require('../dist/extension/shared/conversationTimelineWindow.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const {
  createPersistedConversationTimelineClientPatches
} = require('../dist/extension/backend/application/conversationTimelineClientPatch.js');

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

test('统一 commitSeq 会拒绝旧 page/patch，并允许同提交幂等应用', () => {
  assert.equal(conversationTimelineCommitCanApply(4, 5), false);
  assert.equal(conversationTimelineCommitCanApply(5, 5), true);
  assert.equal(conversationTimelineCommitCanApply(6, 5), true);
});

test('prepend 锚点只允许同 conversation、同请求且用户未移动时恢复', () => {
  const anchor = { conversationId: 'conv-window', requestRevision: 3, scrollTop: 120 };
  assert.equal(conversationTimelinePrependAnchorCanRestore(anchor, 'conv-window', 3, 121), true);
  assert.equal(conversationTimelinePrependAnchorCanRestore(anchor, 'other-conversation', 3, 120), false);
  assert.equal(conversationTimelinePrependAnchorCanRestore(anchor, 'conv-window', 4, 120), false);
  assert.equal(conversationTimelinePrependAnchorCanRestore(anchor, 'conv-window', 3, 140), false);
});

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
  state.compressionBlocks.push({ id: 'compression-retained-1', conversationId: 'conv-window', title: 'summary', status: 'complete', methodKind: 'llm_summary', anchorSeq: 1, endSeq: 1, createdAt: 1, updatedAt: 1 });
  state.compressionBlockLlmInvocationLinks.push({ id: 'compression-invocation-link-retained-1', blockId: 'compression-retained-1', invocationId: 'compression-invocation-retained-1', role: 'compact', createdAt: 1, updatedAt: 1 });
  state.llmInvocations.push({ id: 'compression-invocation-retained-1', requestId: 'compression-request-retained-1', status: 'complete', createdAt: 1 });

  const retained = conversationTimelineStateForMessageIds(state, new Set(['m-1']));
  assert.deepEqual(retained.messages.map((item) => item.id), ['m-1']);
  assert.deepEqual(retained.messageRevisions.map((item) => item.id), ['revision-1']);
  assert.deepEqual(retained.toolCalls.map((item) => item.id), ['tool-1']);
  assert.deepEqual(retained.toolCallEvents.map((item) => item.id), ['event-1']);
  assert.deepEqual(retained.messageRunLinks.map((item) => item.id), ['message-run-1']);
  assert.deepEqual(retained.agentRuns.map((item) => item.id), ['run-1']);
  assert.deepEqual(retained.compressionBlocks.map((item) => item.id), ['compression-retained-1']);
  assert.deepEqual(retained.compressionBlockLlmInvocationLinks.map((item) => item.id), ['compression-invocation-link-retained-1']);
  assert.deepEqual(retained.llmInvocations.map((item) => item.id), ['compression-invocation-retained-1']);
});

test('裁掉旧 chunk 时会清理 checkpoint/compression 的完整 sidecar 闭包', () => {
  const state = createEmptyClientState();
  state.messages.push(message(1), message(101));
  state.projectContexts.push(
    { id: 'project-old', kind: 'folder', uri: 'file:///old', name: 'old', createdAt: 1, updatedAt: 1 },
    { id: 'project-new', kind: 'folder', uri: 'file:///new', name: 'new', createdAt: 1, updatedAt: 1 },
    { id: 'project-primary', kind: 'folder', uri: 'file:///primary', name: 'primary', createdAt: 1, updatedAt: 1 }
  );
  state.conversationProjectLinks.push({
    id: 'conversation-project-primary', conversationId: 'conv-window', projectContextId: 'project-primary', role: 'primary', createdAt: 1, updatedAt: 1
  });
  state.shadowRepositories.push(
    { id: 'shadow-old', storageKey: 'old', createdAt: 1, updatedAt: 1 },
    { id: 'shadow-new', storageKey: 'new', createdAt: 1, updatedAt: 1 }
  );
  state.conversationCheckpointRepositoryLinks.push(
    { id: 'repository-old', conversationId: 'conv-window', projectContextId: 'project-old', shadowRepositoryId: 'shadow-old', projectUri: 'file:///old', projectDisplayPath: '/old', role: 'active', createdAt: 1, updatedAt: 1 },
    { id: 'repository-new', conversationId: 'conv-window', projectContextId: 'project-new', shadowRepositoryId: 'shadow-new', projectUri: 'file:///new', projectDisplayPath: '/new', role: 'active', createdAt: 1, updatedAt: 1 }
  );
  state.checkpoints.push(
    { id: 'checkpoint-old', conversationId: 'conv-window', projectContextId: 'project-old', shadowRepositoryId: 'shadow-old', trigger: 'user_message_before', status: 'created', projectUri: 'file:///old', projectDisplayPath: '/old', createdAt: 1, updatedAt: 1 },
    { id: 'checkpoint-new', conversationId: 'conv-window', projectContextId: 'project-new', shadowRepositoryId: 'shadow-new', trigger: 'user_message_before', status: 'created', projectUri: 'file:///new', projectDisplayPath: '/new', createdAt: 2, updatedAt: 2 }
  );
  state.checkpointTimelineAnchors.push(
    { id: 'anchor-old', conversationId: 'conv-window', checkpointId: 'checkpoint-old', floorMessageId: 'm-1', position: 'before', order: 1, createdAt: 1, updatedAt: 1 },
    { id: 'anchor-new', conversationId: 'conv-window', checkpointId: 'checkpoint-new', floorMessageId: 'm-101', position: 'before', order: 2, createdAt: 2, updatedAt: 2 }
  );
  state.compressionBlocks.push(
    { id: 'compression-old', conversationId: 'conv-window', title: 'old', status: 'complete', methodKind: 'llm_summary', anchorSeq: 1, endSeq: 1, createdAt: 1, updatedAt: 1 },
    { id: 'compression-new', conversationId: 'conv-window', title: 'new', status: 'complete', methodKind: 'llm_summary', anchorSeq: 101, endSeq: 101, createdAt: 2, updatedAt: 2 }
  );
  state.compressionBlockSourceLinks.push(
    { id: 'source-old', blockId: 'compression-old', sourceKind: 'message', sourceId: 'm-1', role: 'source', order: 1, createdAt: 1, updatedAt: 1 },
    { id: 'source-new', blockId: 'compression-new', sourceKind: 'message', sourceId: 'm-101', role: 'source', order: 1, createdAt: 2, updatedAt: 2 }
  );
  state.compressionContextVariants.push(
    { id: 'variant-old', blockId: 'compression-old', kind: 'provider_neutral_summary', contents: [], createdAt: 1, updatedAt: 1 },
    { id: 'variant-new', blockId: 'compression-new', kind: 'provider_neutral_summary', contents: [], createdAt: 2, updatedAt: 2 }
  );
  state.compressionBlockLlmInvocationLinks.push(
    { id: 'invocation-link-old', blockId: 'compression-old', invocationId: 'invocation-old', role: 'compact', createdAt: 1, updatedAt: 1 },
    { id: 'invocation-link-new', blockId: 'compression-new', invocationId: 'invocation-new', role: 'compact', createdAt: 2, updatedAt: 2 }
  );
  state.llmInvocations.push(
    { id: 'invocation-old', requestId: 'request-old', status: 'complete', createdAt: 1 },
    { id: 'invocation-new', requestId: 'request-new', status: 'complete', createdAt: 2 }
  );

  pruneConversationTimelineStateToWindow(state, 'conv-window', [chunk(1, 101, 200)], false);

  assert.deepEqual(state.messages.map((item) => item.id), ['m-101']);
  assert.deepEqual(state.checkpointTimelineAnchors.map((item) => item.id), ['anchor-new']);
  assert.deepEqual(state.checkpoints.map((item) => item.id), ['checkpoint-new']);
  assert.deepEqual(state.conversationCheckpointRepositoryLinks.map((item) => item.id), ['repository-new']);
  assert.deepEqual(state.projectContexts.map((item) => item.id).sort(), ['project-new', 'project-primary']);
  assert.deepEqual(state.shadowRepositories.map((item) => item.id), ['shadow-new']);
  assert.deepEqual(state.compressionBlocks.map((item) => item.id), ['compression-new']);
  assert.deepEqual(state.compressionBlockSourceLinks.map((item) => item.id), ['source-new']);
  assert.deepEqual(state.compressionContextVariants.map((item) => item.id), ['variant-new']);
  assert.deepEqual(state.compressionBlockLlmInvocationLinks.map((item) => item.id), ['invocation-link-new']);
  assert.deepEqual(state.llmInvocations.map((item) => item.id), ['invocation-new']);
});

test('持久化 timeline patch 会广播 page-owned checkpoint/compression 的精确删除', () => {
  const previous = createEmptyClientState();
  previous.messages.push(message(1));
  previous.projectContexts.push({ id: 'project-1', kind: 'folder', uri: 'file:///project', name: 'project', createdAt: 1, updatedAt: 1 });
  previous.shadowRepositories.push({ id: 'shadow-1', storageKey: 'shadow', createdAt: 1, updatedAt: 1 });
  previous.conversationCheckpointRepositoryLinks.push({ id: 'repository-1', conversationId: 'conv-window', projectContextId: 'project-1', shadowRepositoryId: 'shadow-1', projectUri: 'file:///project', projectDisplayPath: '/project', role: 'active', createdAt: 1, updatedAt: 1 });
  previous.checkpoints.push({ id: 'checkpoint-1', conversationId: 'conv-window', projectContextId: 'project-1', shadowRepositoryId: 'shadow-1', trigger: 'user_message_before', status: 'created', projectUri: 'file:///project', projectDisplayPath: '/project', createdAt: 1, updatedAt: 1 });
  previous.checkpointTimelineAnchors.push({ id: 'anchor-1', conversationId: 'conv-window', checkpointId: 'checkpoint-1', floorMessageId: 'm-1', position: 'before', order: 1, createdAt: 1, updatedAt: 1 });
  previous.compressionBlocks.push({ id: 'compression-1', conversationId: 'conv-window', title: 'summary', status: 'complete', methodKind: 'llm_summary', anchorSeq: 1, endSeq: 1, createdAt: 1, updatedAt: 1 });
  previous.compressionBlockSourceLinks.push({ id: 'source-1', blockId: 'compression-1', sourceKind: 'message', sourceId: 'm-1', role: 'source', order: 1, createdAt: 1, updatedAt: 1 });
  previous.compressionContextVariants.push({ id: 'variant-1', blockId: 'compression-1', kind: 'provider_neutral_summary', contents: [], createdAt: 1, updatedAt: 1 });
  previous.compressionBlockLlmInvocationLinks.push({ id: 'invocation-link-1', blockId: 'compression-1', invocationId: 'invocation-1', role: 'compact', createdAt: 1, updatedAt: 1 });
  previous.llmInvocations.push({ id: 'invocation-1', requestId: 'request-1', status: 'complete', createdAt: 1 });

  const next = JSON.parse(JSON.stringify(previous));
  next.projectContexts = [];
  next.shadowRepositories = [];
  next.conversationCheckpointRepositoryLinks = [];
  next.checkpoints = [];
  next.checkpointTimelineAnchors = [];
  next.compressionBlocks = [];
  next.compressionBlockSourceLinks = [];
  next.compressionContextVariants = [];
  next.compressionBlockLlmInvocationLinks = [];
  next.llmInvocations = [];

  const patches = createPersistedConversationTimelineClientPatches(previous, next);
  assert.deepEqual(new Set(patches.map((patch) => patch.kind)), new Set([
    'projectContext.remove',
    'shadowRepository.remove',
    'conversationCheckpointRepositoryLink.remove',
    'checkpoint.remove',
    'checkpointTimelineAnchor.remove',
    'compressionBlock.remove',
    'compressionBlockSourceLink.remove',
    'compressionContextVariant.remove',
    'compressionBlockLlmInvocationLink.remove',
    'llmInvocation.remove'
  ]));
});
