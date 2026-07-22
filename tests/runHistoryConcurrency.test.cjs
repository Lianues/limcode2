const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
  }

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static joinPath(base, ...segments) {
    return new MockUri(path.join(base.fsPath, ...segments));
  }

  toString() {
    return `file://${this.fsPath.replace(/\\/g, '/')}`;
  }
}

function installVscodeMock() {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        delete: (uri, options = {}) => fs.rm(uri.fsPath, { recursive: options.recursive === true, force: false }),
        readFile: (uri) => fs.readFile(uri.fsPath),
        writeFile: async (uri, data) => {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, data);
        }
      }
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mock;
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => { Module._load = originalLoad; };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTempRoot(target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code)) throw error;
      await delay(25 * attempt);
    }
  }
}

function shortHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function safeShardName(id) {
  const slug = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
  return `${slug}-${shortHash(id)}`;
}

function runHistoryConversationRoot(paths, conversationId) {
  return path.join(paths.runHistoryRootUri.fsPath, 'conversations', safeShardName(conversationId));
}

function runDetailPath(paths, runId) {
  return path.join(paths.runHistoryRootUri.fsPath, 'runs', `${safeShardName(runId)}.json`);
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function enableRunHistory(paths) {
  await fs.mkdir(paths.settingsRootUri.fsPath, { recursive: true });
  await fs.writeFile(path.join(paths.settingsRootUri.fsPath, 'run-history.json'), `${JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-07-22T00:00:00.000Z',
    settings: { detailPersistenceEnabled: true }
  }, null, 2)}\n`, 'utf8');
}

function textMessage(conversationId, id, seq, text, role = 'user') {
  return {
    id,
    conversationId,
    role,
    content: { parts: [{ text }] },
    status: 'complete',
    createdAt: 1_700_100_000_000 + seq,
    seq
  };
}

function makeRunState(createEmptyClientState, conversationId, runId, options = {}) {
  const now = options.now ?? 1_700_200_000_000;
  const state = createEmptyClientState();
  const inputMessageId = `${conversationId}-${runId}-input`;
  const outputMessageId = `${conversationId}-${runId}-output`;
  const revisionId = `${conversationId}-${runId}-revision`;
  const toolCallId = `${conversationId}-${runId}-tool`;
  const blockId = `${conversationId}-${runId}-compression`;
  const variantId = `${conversationId}-${runId}-variant`;
  const invocationId = `${conversationId}-${runId}-llm`;
  state.conversations.push({ id: conversationId, title: conversationId, visibility: 'visible' });
  state.agentRuns.push({
    id: runId,
    kind: 'chat',
    status: options.status ?? 'completed',
    createdAt: now,
    updatedAt: now + 10,
    completedAt: now + 10,
    endReason: 'completed'
  });
  state.agentRunSourceLinks.push({
    id: `${runId}-${conversationId}-source`,
    runId,
    sourceKind: 'user',
    sourceConversationId: conversationId,
    sourceMessageId: inputMessageId,
    sourceToolCallId: toolCallId
  });
  state.agentRunTargetLinks.push({
    id: `${runId}-${conversationId}-target`,
    runId,
    agentId: options.agentId ?? 'agent-main',
    conversationId,
    role: 'executor'
  });
  state.messages.push(textMessage(conversationId, inputMessageId, options.inputSeq ?? 1, `input ${runId}`, 'user'));
  state.messages.push(textMessage(conversationId, outputMessageId, options.outputSeq ?? 2, `output ${runId}`, 'model'));
  state.messageRevisions.push({
    id: revisionId,
    conversationId,
    messageId: inputMessageId,
    content: { parts: [{ text: `revision ${runId}` }] },
    createdAt: now + 1
  });
  state.messageCurrentRevisionLinks.push({ id: `${revisionId}-current`, conversationId, messageId: inputMessageId, revisionId });
  state.toolCalls.push({
    id: toolCallId,
    messageId: inputMessageId,
    name: 'shell',
    args: '{}',
    status: 'success',
    result: { ok: true },
    createdAt: now + 2,
    updatedAt: now + 3
  });
  state.toolCallEvents.push({ id: `${toolCallId}-event`, toolCallId, seq: 1, kind: 'completed', createdAt: now + 4 });
  state.messageRunLinks.push({ id: `${runId}-${conversationId}-input-link`, runId, messageId: inputMessageId, role: 'input' });
  state.messageRunLinks.push({ id: `${runId}-${conversationId}-output-link`, runId, messageId: outputMessageId, role: 'model' });
  state.toolCallRunLinks.push({ id: `${runId}-${conversationId}-tool-link`, runId, toolCallId, role: 'tool' });
  state.agentRunInputRevisions.push({ id: `${runId}-${conversationId}-input-revision`, runId, conversationId, revisionId, role: 'input' });
  state.runConversationPolicies.push({ id: `${runId}-${conversationId}-conversation-policy`, conversationId, createdAt: now, updatedAt: now + 1 });
  state.runConversationPolicyLinks.push({ id: `${runId}-${conversationId}-conversation-policy-link`, runId, policyId: `${runId}-${conversationId}-conversation-policy`, role: 'active' });
  state.runDeliveryPolicies.push({ id: `${runId}-${conversationId}-delivery-policy`, targetConversationId: conversationId, targetToolCallId: toolCallId, createdAt: now, updatedAt: now + 1 });
  state.runDeliveryPolicyLinks.push({ id: `${runId}-${conversationId}-delivery-policy-link`, runId, policyId: `${runId}-${conversationId}-delivery-policy`, role: 'active' });
  state.llmInvocations.push({ id: invocationId, provider: 'openai', model: 'test-model', status: 'completed', createdAt: now, updatedAt: now + 1 });
  state.runLlmInvocationLinks.push({ id: `${runId}-${conversationId}-run-llm`, runId, invocationId, role: 'primary' });
  state.messageLlmInvocationLinks.push({ id: `${runId}-${conversationId}-message-llm`, messageId: outputMessageId, invocationId, role: 'response' });
  state.compressionBlocks.push({
    id: blockId,
    conversationId,
    title: `compression ${conversationId}`,
    status: 'complete',
    methodKind: 'llm',
    createdAt: now,
    updatedAt: now + 1
  });
  state.compressionBlockSourceLinks.push({ id: `${blockId}-source`, blockId, sourceKind: 'message', sourceId: inputMessageId, revisionId, role: 'source', order: 0, createdAt: now, updatedAt: now + 1 });
  state.compressionContextVariants.push({ id: variantId, blockId, kind: 'summary', contents: [{ parts: [{ text: `summary ${conversationId}` }] }], createdAt: now, updatedAt: now + 1 });
  state.compressionBlockLlmInvocationLinks.push({ id: `${blockId}-llm`, blockId, invocationId, role: 'summary', createdAt: now, updatedAt: now + 1 });
  state.runCompressionBlockLinks.push({ id: `${runId}-${conversationId}-compression-link`, runId, blockId, variantId, role: 'context', mode: 'replace', createdAt: now, updatedAt: now + 1 });
  return state;
}

const restore = installVscodeMock();
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

test('同 conversation 并发 merge 不丢 run summaries', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-run-history-conv-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-run-concurrent';
  try {
    await enableRunHistory(paths);
    await Promise.all([
      clientStateStore.saveConversationRunHistoryToStores(paths, conversationId, makeRunState(createEmptyClientState, conversationId, 'run-a', { now: 100 }), { mode: 'merge' }),
      clientStateStore.saveConversationRunHistoryToStores(paths, conversationId, makeRunState(createEmptyClientState, conversationId, 'run-b', { now: 200 }), { mode: 'merge' })
    ]);

    const page = await clientStateStore.loadConversationRunHistoryPageFromStores(paths, { conversationId });
    assert.equal(page.pageInfo.total, 2);
    assert.deepEqual(page.runs.map((run) => run.id).sort(), ['run-a', 'run-b']);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('同 runId 不同 conversation 并发写 shared detail 不丢 summaries/state', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-run-history-shared-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const runId = 'shared-run';
  const conversationA = 'conv-shared-a';
  const conversationB = 'conv-shared-b';
  try {
    await enableRunHistory(paths);
    await Promise.all([
      clientStateStore.saveConversationRunHistoryToStores(paths, conversationA, makeRunState(createEmptyClientState, conversationA, runId, { now: 300, agentId: 'agent-a' }), { mode: 'merge' }),
      clientStateStore.saveConversationRunHistoryToStores(paths, conversationB, makeRunState(createEmptyClientState, conversationB, runId, { now: 400, agentId: 'agent-b' }), { mode: 'merge' })
    ]);

    const detailA = await clientStateStore.loadConversationRunDetailFromStores(paths, { conversationId: conversationA, runId });
    const detailB = await clientStateStore.loadConversationRunDetailFromStores(paths, { conversationId: conversationB, runId });
    assert.ok(detailA);
    assert.ok(detailB);
    assert.equal(detailA.summary.conversationId, conversationA);
    assert.equal(detailB.summary.conversationId, conversationB);
    assert.deepEqual(detailA.state.agentRunTargetLinks.map((link) => link.conversationId).sort(), [conversationA, conversationB].sort());
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('page 写成功但 index 发布失败时旧 generation 仍完整', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-run-history-publish-fail-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-run-publish-fail';
  try {
    await enableRunHistory(paths);
    await clientStateStore.saveConversationRunHistoryToStores(paths, conversationId, makeRunState(createEmptyClientState, conversationId, 'run-old', { now: 500 }), { mode: 'merge' });
    const root = runHistoryConversationRoot(paths, conversationId);
    const beforeIndex = await readJsonFile(path.join(root, 'index.json'));

    clientStateStore.__runHistoryStoreTestHooks.beforePublishConversationIndex = async () => {
      throw new Error('simulated run-history index publish failure');
    };
    await assert.rejects(
      clientStateStore.saveConversationRunHistoryToStores(paths, conversationId, makeRunState(createEmptyClientState, conversationId, 'run-new', { now: 600 }), { mode: 'merge' }),
      /simulated run-history index publish failure/
    );
    clientStateStore.__runHistoryStoreTestHooks.beforePublishConversationIndex = undefined;

    const afterIndex = await readJsonFile(path.join(root, 'index.json'));
    assert.equal(afterIndex.generation, beforeIndex.generation);
    const page = await clientStateStore.loadConversationRunHistoryPageFromStores(paths, { conversationId });
    assert.deepEqual(page.runs.map((run) => run.id), ['run-old']);
  } finally {
    clientStateStore.__runHistoryStoreTestHooks.beforePublishConversationIndex = undefined;
    await removeTempRoot(tempRoot);
  }
});

test('reader 读到旧 index 后 generation 被清理时会重试到新 index', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-run-history-reader-retry-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-run-reader-retry';
  let switched = false;
  try {
    await enableRunHistory(paths);
    await clientStateStore.saveConversationRunHistoryToStores(paths, conversationId, makeRunState(createEmptyClientState, conversationId, 'run-old', { now: 610 }), { mode: 'merge' });
    clientStateStore.__runHistoryStoreTestHooks.beforeReadConversationPage = async () => {
      if (switched) return;
      switched = true;
      await clientStateStore.saveConversationRunHistoryToStores(paths, conversationId, makeRunState(createEmptyClientState, conversationId, 'run-new', { now: 620 }), { mode: 'replace' });
    };

    const page = await clientStateStore.loadConversationRunHistoryPageFromStores(paths, { conversationId });
    assert.equal(page.pageInfo.total, 1);
    assert.deepEqual(page.runs.map((run) => run.id), ['run-new']);
    assert.equal(switched, true);
  } finally {
    clientStateStore.__runHistoryStoreTestHooks.beforeReadConversationPage = undefined;
    await removeTempRoot(tempRoot);
  }
});

test('reader 读到缺失 page 且 generation 未变时返回明确空页而非 total>0 空 runs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-run-history-reader-missing-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-run-reader-missing';
  try {
    await enableRunHistory(paths);
    await clientStateStore.saveConversationRunHistoryToStores(paths, conversationId, makeRunState(createEmptyClientState, conversationId, 'run-old', { now: 630 }), { mode: 'merge' });
    const root = runHistoryConversationRoot(paths, conversationId);
    const index = await readJsonFile(path.join(root, 'index.json'));
    await fs.rm(path.join(root, ...index.pages[0].file.split('/')));

    const page = await clientStateStore.loadConversationRunHistoryPageFromStores(paths, { conversationId });
    assert.equal(page.pageInfo.total, 0);
    assert.deepEqual(page.runs, []);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('删除 conversation A 会 prune shared detail 且保留 B summary', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-run-history-delete-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const runId = 'shared-delete-run';
  const conversationA = 'conv-delete-a';
  const conversationB = 'conv-delete-b';
  try {
    await enableRunHistory(paths);
    await Promise.all([
      clientStateStore.saveConversationRunHistoryToStores(paths, conversationA, makeRunState(createEmptyClientState, conversationA, runId, { now: 700, agentId: 'agent-a' }), { mode: 'merge' }),
      clientStateStore.saveConversationRunHistoryToStores(paths, conversationB, makeRunState(createEmptyClientState, conversationB, runId, { now: 800, agentId: 'agent-b' }), { mode: 'merge' })
    ]);

    const deleteResult = await clientStateStore.deleteConversationDataFromStores(paths, conversationA);
    assert.equal(deleteResult.ok, true, deleteResult.errors.join('\n'));

    const detailA = await clientStateStore.loadConversationRunDetailFromStores(paths, { conversationId: conversationA, runId });
    const detailB = await clientStateStore.loadConversationRunDetailFromStores(paths, { conversationId: conversationB, runId });
    assert.equal(detailA, undefined);
    assert.ok(detailB);
    assert.equal(detailB.summary.conversationId, conversationB);
    const detailFile = await readJsonFile(runDetailPath(paths, runId));
    assert.deepEqual(detailFile.summaries.map((summary) => summary.conversationId), [conversationB]);
    const state = detailFile.state;
    const assertNoA = (items, predicate, label) => {
      assert.equal(items.some(predicate), false, `${label} should not retain deleted conversation A data`);
    };
    assertNoA(state.conversations, (conversation) => conversation.id === conversationA, 'conversations');
    assertNoA(state.messages, (message) => message.conversationId === conversationA || message.id.includes(conversationA), 'messages');
    assertNoA(state.messageRevisions, (revision) => revision.conversationId === conversationA || revision.messageId.includes(conversationA), 'messageRevisions');
    assertNoA(state.messageCurrentRevisionLinks, (link) => link.messageId.includes(conversationA) || link.revisionId.includes(conversationA), 'messageCurrentRevisionLinks');
    assertNoA(state.toolCalls, (toolCall) => toolCall.id.includes(conversationA) || toolCall.messageId.includes(conversationA), 'toolCalls');
    assertNoA(state.toolCallEvents, (event) => event.toolCallId.includes(conversationA), 'toolCallEvents');
    assertNoA(state.agentRunSourceLinks, (link) => link.sourceConversationId === conversationA || String(link.sourceMessageId).includes(conversationA) || String(link.sourceToolCallId).includes(conversationA), 'agentRunSourceLinks');
    assertNoA(state.agentRunTargetLinks, (link) => link.conversationId === conversationA, 'agentRunTargetLinks');
    assertNoA(state.messageRunLinks, (link) => link.messageId.includes(conversationA), 'messageRunLinks');
    assertNoA(state.toolCallRunLinks, (link) => link.toolCallId.includes(conversationA), 'toolCallRunLinks');
    assertNoA(state.agentRunInputRevisions, (input) => input.conversationId === conversationA || input.revisionId.includes(conversationA), 'agentRunInputRevisions');
    assertNoA(state.runConversationPolicies, (policy) => policy.conversationId === conversationA || policy.branchFromConversationId === conversationA, 'runConversationPolicies');
    assertNoA(state.runDeliveryPolicies, (policy) => policy.targetConversationId === conversationA || String(policy.targetToolCallId).includes(conversationA), 'runDeliveryPolicies');
    assertNoA(state.compressionBlocks, (block) => block.conversationId === conversationA || block.id.includes(conversationA), 'compressionBlocks');
    assertNoA(state.compressionBlockSourceLinks, (link) => link.blockId.includes(conversationA) || link.sourceId.includes(conversationA) || String(link.revisionId).includes(conversationA), 'compressionBlockSourceLinks');
    assertNoA(state.compressionContextVariants, (variant) => variant.blockId.includes(conversationA) || variant.id.includes(conversationA), 'compressionContextVariants');
    assertNoA(state.runCompressionBlockLinks, (link) => link.blockId.includes(conversationA) || String(link.variantId).includes(conversationA), 'runCompressionBlockLinks');
    assertNoA(state.messageLlmInvocationLinks, (link) => link.messageId.includes(conversationA), 'messageLlmInvocationLinks');
    assert.equal(state.agentRuns.some((run) => run.id === runId), true, 'shared run body should remain');
    assert.equal(state.agentRunTargetLinks.some((link) => link.conversationId === conversationB), true, 'B target link should remain');
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('收尾恢复 vscode mock', () => {
  restore();
});
