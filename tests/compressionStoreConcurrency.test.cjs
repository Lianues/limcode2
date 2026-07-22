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

  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
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
        delete: (uri, options = {}) => fs.rm(uri.fsPath, { recursive: !!options.recursive, force: false }),
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compressionState(createEmptyClientState, conversationId, suffix, seq = 1) {
  const state = createEmptyClientState();
  const blockId = `block-${suffix}`;
  const variantId = `variant-${suffix}`;
  const invocationId = `invocation-${suffix}`;
  state.compressionBlocks.push({
    id: blockId,
    conversationId,
    title: `summary ${suffix}`,
    status: 'complete',
    methodKind: 'llm',
    anchorSeq: seq,
    endSeq: seq,
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_100 + seq
  });
  state.compressionBlockSourceLinks.push({
    id: `source-${suffix}`,
    blockId,
    sourceKind: 'message',
    sourceId: `message-${suffix}`,
    role: 'source',
    order: 0,
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_100 + seq
  });
  state.compressionContextVariants.push({
    id: variantId,
    blockId,
    kind: 'summary',
    contents: [{ parts: [{ text: `summary ${suffix}` }] }],
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_100 + seq
  });
  state.compressionBlockLlmInvocationLinks.push({
    id: `invocation-link-${suffix}`,
    blockId,
    invocationId,
    role: 'summary',
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_100 + seq
  });
  state.llmInvocations.push({
    id: invocationId,
    provider: 'openai',
    model: 'test-model',
    status: 'completed',
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_100 + seq
  });
  return state;
}

const restore = installVscodeMock();
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const compressionStore = require('../dist/extension/backend/capabilities/vscodeStorage/compressionStore.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');

test('compression save 中途失败后 reader 拒绝 writing/mixed，下一次完整 save 修复', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-compression-fail-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-compression-fail';
  try {
    let failed = false;
    compressionStore.__compressionStoreTestHooks.afterStoreSave = async ({ store }) => {
      if (!failed && store === 'blocks') {
        failed = true;
        throw new Error('simulated compression save failure');
      }
    };

    await assert.rejects(
      () => compressionStore.saveConversationCompressionDetail(paths, conversationId, compressionState(createEmptyClientState, conversationId, 'broken', 1)),
      /simulated compression save failure/
    );
    await assert.rejects(
      () => compressionStore.loadConversationCompressionDetail(paths, conversationId),
      /not committed|manifest/i
    );

    compressionStore.__compressionStoreTestHooks.afterStoreSave = undefined;
    await compressionStore.saveConversationCompressionDetail(paths, conversationId, compressionState(createEmptyClientState, conversationId, 'fixed', 2));
    const loaded = await compressionStore.loadConversationCompressionDetail(paths, conversationId);
    assert.ok(loaded);
    assert.deepEqual(loaded.compressionBlocks.map((block) => block.id), ['block-fixed']);
    assert.deepEqual(loaded.compressionContextVariants.map((variant) => variant.id), ['variant-fixed']);
    assert.deepEqual(loaded.llmInvocations.map((invocation) => invocation.id), ['invocation-fixed']);
  } finally {
    compressionStore.__compressionStoreTestHooks.afterStoreSave = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('compression concurrent reader waits for transaction and only sees complete old or new snapshot', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-compression-concurrent-'));
  const paths = createVscodeStoragePaths(MockUri.file(tempRoot));
  const conversationId = 'conv-compression-concurrent';
  const gate = deferred();
  const saveBlocked = deferred();
  try {
    await compressionStore.saveConversationCompressionDetail(paths, conversationId, compressionState(createEmptyClientState, conversationId, 'old', 1));
    const old = await compressionStore.loadConversationCompressionDetail(paths, conversationId);
    assert.deepEqual(old.compressionBlocks.map((block) => block.id), ['block-old']);

    let blocked = false;
    compressionStore.__compressionStoreTestHooks.afterStoreSave = async ({ store }) => {
      if (!blocked && store === 'blocks') {
        blocked = true;
        saveBlocked.resolve();
        await gate.promise;
      }
    };

    const saving = compressionStore.saveConversationCompressionDetail(paths, conversationId, compressionState(createEmptyClientState, conversationId, 'new', 2));
    await saveBlocked.promise;

    let readerResolved = false;
    const reading = compressionStore.loadConversationCompressionDetail(paths, conversationId).then((value) => {
      readerResolved = true;
      return value;
    });
    await delay(40);
    assert.equal(readerResolved, false, 'reader must wait for the compression transaction lock');

    gate.resolve();
    await saving;
    const loaded = await reading;
    assert.deepEqual(loaded.compressionBlocks.map((block) => block.id), ['block-new']);
    assert.deepEqual(loaded.compressionContextVariants.map((variant) => variant.id), ['variant-new']);
  } finally {
    compressionStore.__compressionStoreTestHooks.afterStoreSave = undefined;
    gate.resolve();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('收尾恢复 vscode mock', () => {
  restore();
});
