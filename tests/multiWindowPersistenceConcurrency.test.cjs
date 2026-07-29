const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const Module = require('node:module');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.replace(/\\/g, '/');
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

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for barrier file: ${file}`);
    await delay(10);
  }
}

async function touch(file, content = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

function addBundle(state, suffix) {
  state.conversations.push({ id: `conversation-${suffix}`, title: suffix, visibility: 'visible' });
  state.agents.push({ id: `agent-${suffix}`, name: suffix, kind: 'main', createdAt: 1, updatedAt: 1 });
  state.agentConversationLinks.push({
    id: `link-${suffix}`,
    agentId: `agent-${suffix}`,
    conversationId: `conversation-${suffix}`,
    role: 'default'
  });
  return state;
}

function message(conversationId, id, seq, text, status = 'complete', role = 'model') {
  return {
    id,
    conversationId,
    role,
    content: { parts: [{ text }] },
    status,
    createdAt: 1_700_000_000_000 + seq,
    seq
  };
}

async function runWorker(mode, rootPath, label, extra) {
  const restore = installVscodeMock();
  try {
    const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
    const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
    const paths = createVscodeStoragePaths(MockUri.file(rootPath));
    const barriers = path.join(rootPath, 'test-barriers');

    if (mode === 'skeleton-add') {
      const store = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
      const transaction = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonTransaction.js');
      const patch = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonPatch.js');
      const pin = await transaction.openClientStateSkeletonSnapshot(paths, `worker-${label}`);
      assert.ok(pin);
      let base;
      try {
        base = await store.loadClientStateSkeletonSnapshotFromStores(paths, pin, { profile: 'full' });
      } finally {
        await transaction.releaseClientStateSkeletonSnapshot(paths, pin);
      }
      await touch(path.join(barriers, `ready-${label}`));
      await waitForFile(path.join(barriers, `go-${label}`));
      const next = addBundle(clone(base), label);
      await store.saveClientStateSkeletonToStores(paths, patch.createClientStateSkeletonPatch(base, next));
      await touch(path.join(barriers, `done-${label}`));
      return;
    }

    if (mode === 'timeline') {
      const timeline = require('../dist/extension/backend/capabilities/vscodeStorage/conversationTimelineStore.js');
      const conversationId = 'conversation-shared-timeline';
      const page = await timeline.loadConversationTimelinePage(paths, {
        conversationId,
        direction: 'initial',
        chunkCount: 1
      });
      const base = page.state; // 只加载尾 chunk，模拟正常面板首屏，而不是完整 context。
      assert.equal(base.messages.length, 1);
      await touch(path.join(barriers, `ready-${label}`));
      await waitForFile(path.join(barriers, `go-${label}`));
      const next = clone(base);
      if (label === 'A') {
        next.messages[0].content.parts[0].text = 'NEW FINAL CONTENT';
        next.messages[0].status = 'complete';
        next.messages.push(message(conversationId, 'append-A', 102, 'append from A', 'complete', 'user'));
      } else {
        // 两个 Extension Host 都从相同 maxSeq 分配到 seq=102；存储必须保留两个 id，
        // 并用 createdAt/id tie-break 得到跨进程稳定总序，而不是按 seq 去重。
        next.messages.push(message(conversationId, 'append-B', 102, 'append from stale B', 'complete', 'user'));
      }
      await timeline.commitConversationTimelineRenderDetail(paths, conversationId, base, next);
      await touch(path.join(barriers, `done-${label}`));
      return;
    }

    if (mode === 'settings') {
      const providerStore = require('../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
      const settingsPaths = { settingsRootUri: paths.settingsRootUri };
      const base = await providerStore.loadLlmProviderConfigsSettings(settingsPaths);
      await touch(path.join(barriers, `ready-${label}`));
      await waitForFile(path.join(barriers, `go-${label}`));
      const added = providerStore.createDefaultLlmProviderConfig({ name: `provider-${label}` });
      try {
        await providerStore.saveLlmProviderConfigsSettings(
          settingsPaths,
          { configs: [...base.settings.configs, added] },
          base.revision
        );
        await touch(path.join(barriers, `result-${label}`), 'success');
      } catch (error) {
        if (!error || error.settingsRevisionConflict !== true) throw error;
        await touch(path.join(barriers, `result-${label}`), 'conflict');
      }
      return;
    }

    if (mode === 'skeleton-crash') {
      const store = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
      const transaction = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonTransaction.js');
      const patch = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonPatch.js');
      const pin = await transaction.openClientStateSkeletonSnapshot(paths, `crash-${extra}`);
      assert.ok(pin);
      let base;
      try {
        base = await store.loadClientStateSkeletonSnapshotFromStores(paths, pin, { profile: 'full' });
      } finally {
        await transaction.releaseClientStateSkeletonSnapshot(paths, pin);
      }
      const next = clone(base);
      next.conversations[0].title = label;
      transaction.__clientStateSkeletonTransactionTestHooks.afterPhase = async (phase) => {
        if (phase === extra) process.exit(86);
      };
      await store.saveClientStateSkeletonToStores(paths, patch.createClientStateSkeletonPatch(base, next));
      throw new Error(`Crash phase was not reached: ${extra}`);
    }

    throw new Error(`Unknown worker mode: ${mode}`);
  } finally {
    restore();
  }
}

function spawnWorker(mode, rootPath, label, extra, expectedCode = 0) {
  const child = spawn(process.execPath, [__filename, '--worker', mode, rootPath, label, extra ?? ''], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!signal && code === expectedCode) resolve({ pid: child.pid, stdout, stderr });
      else reject(new Error(`worker ${mode}/${label} failed (code=${code}, signal=${signal}): ${stderr || stdout}`));
    });
  });
  return { child, completed };
}

if (process.argv[2] === '--worker') {
  runWorker(process.argv[3], process.argv[4], process.argv[5], process.argv[6])
    .then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
} else {
  const restore = installVscodeMock();
  const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
  const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
  const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
  const skeletonTransaction = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonTransaction.js');
  const skeletonPatch = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonPatch.js');
  const timeline = require('../dist/extension/backend/capabilities/vscodeStorage/conversationTimelineStore.js');
  const providerStore = require('../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');

  async function commitSkeleton(paths, base, next) {
    await clientStateStore.saveClientStateSkeletonToStores(paths, skeletonPatch.createClientStateSkeletonPatch(base, next));
  }

  async function loadCurrentSkeleton(paths) {
    const pin = await skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'parent-reader');
    if (!pin) return undefined;
    try {
      return await clientStateStore.loadClientStateSkeletonSnapshotFromStores(paths, pin, { profile: 'full' });
    } finally {
      await skeletonTransaction.releaseClientStateSkeletonSnapshot(paths, pin);
    }
  }

  async function withTemp(prefix, action) {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      return await action(createVscodeStoragePaths(MockUri.file(rootPath)), rootPath);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }

  test('真实多进程 skeleton writers 基于同一陈旧 base 提交不同 id 时保留 union', async () => {
    await withTemp('limcode-multi-window-skeleton-', async (paths, rootPath) => {
      const base = addBundle(createEmptyClientState(), 'base');
      await commitSkeleton(paths, createEmptyClientState(), base);
      const workerA = spawnWorker('skeleton-add', rootPath, 'A');
      const workerB = spawnWorker('skeleton-add', rootPath, 'B');
      const barriers = path.join(rootPath, 'test-barriers');
      await Promise.all([
        waitForFile(path.join(barriers, 'ready-A')),
        waitForFile(path.join(barriers, 'ready-B'))
      ]);
      await Promise.all([
        touch(path.join(barriers, 'go-A')),
        touch(path.join(barriers, 'go-B'))
      ]);
      await Promise.all([workerA.completed, workerB.completed]);

      const stored = await loadCurrentSkeleton(paths);
      assert.deepEqual(stored.conversations.map((item) => item.id).sort(), [
        'conversation-A', 'conversation-B', 'conversation-base'
      ]);
      assert.deepEqual(stored.agentConversationLinks.map((item) => item.id).sort(), [
        'link-A', 'link-B', 'link-base'
      ]);
    });
  });

  test('真实多进程 timeline 陈旧窗口追加不会回退另一窗口完成的同 id 消息', async () => {
    await withTemp('limcode-multi-window-timeline-', async (paths, rootPath) => {
      const conversationId = 'conversation-shared-timeline';
      const initial = createEmptyClientState();
      for (let seq = 1; seq <= 100; seq += 1) {
        initial.messages.push(message(conversationId, `prefix-${seq}`, seq, `prefix ${seq}`, 'complete', seq % 2 ? 'user' : 'model'));
      }
      initial.messages.push(message(conversationId, 'stream-1', 101, 'OLD PARTIAL CONTENT', 'streaming'));
      await timeline.saveConversationTimelineDetail(paths, conversationId, initial);

      const workerA = spawnWorker('timeline', rootPath, 'A');
      const workerB = spawnWorker('timeline', rootPath, 'B');
      const barriers = path.join(rootPath, 'test-barriers');
      await Promise.all([
        waitForFile(path.join(barriers, 'ready-A')),
        waitForFile(path.join(barriers, 'ready-B'))
      ]);
      await touch(path.join(barriers, 'go-A'));
      await workerA.completed;
      await touch(path.join(barriers, 'go-B'));
      await workerB.completed;

      const stored = await timeline.loadConversationTimelineDetail(paths, conversationId);
      assert.equal(stored.messages.length, 103);
      assert.equal(stored.messages[0].id, 'prefix-1');
      assert.equal(stored.messages.find((item) => item.id === 'stream-1').content.parts[0].text, 'NEW FINAL CONTENT');
      assert.equal(stored.messages.find((item) => item.id === 'stream-1').status, 'complete');
      assert.deepEqual(stored.messages.filter((item) => item.seq === 102).map((item) => item.id), ['append-A', 'append-B']);
    });
  });

  test('真实多进程 settings CAS 只接受一个陈旧提交，冲突方 rebase 后可无损合并', async () => {
    await withTemp('limcode-multi-window-settings-', async (paths, rootPath) => {
      const settingsPaths = { settingsRootUri: paths.settingsRootUri };
      await providerStore.loadLlmProviderConfigsSettings(settingsPaths);
      const workerA = spawnWorker('settings', rootPath, 'A');
      const workerB = spawnWorker('settings', rootPath, 'B');
      const barriers = path.join(rootPath, 'test-barriers');
      await Promise.all([
        waitForFile(path.join(barriers, 'ready-A')),
        waitForFile(path.join(barriers, 'ready-B'))
      ]);
      await Promise.all([
        touch(path.join(barriers, 'go-A')),
        touch(path.join(barriers, 'go-B'))
      ]);
      await Promise.all([workerA.completed, workerB.completed]);

      const resultA = await fs.readFile(path.join(barriers, 'result-A'), 'utf8');
      const resultB = await fs.readFile(path.join(barriers, 'result-B'), 'utf8');
      assert.deepEqual([resultA, resultB].sort(), ['conflict', 'success']);

      const current = await providerStore.loadLlmProviderConfigsSettings(settingsPaths);
      const loser = resultA === 'conflict' ? 'A' : 'B';
      const rebased = providerStore.createDefaultLlmProviderConfig({ name: `provider-${loser}` });
      await providerStore.saveLlmProviderConfigsSettings(
        settingsPaths,
        { configs: [...current.settings.configs, rebased] },
        current.revision
      );
      const names = (await providerStore.loadLlmProviderConfigsSettings(settingsPaths)).settings.configs
        .map((item) => item.name)
        .sort();
      assert.deepEqual(names, ['provider-A', 'provider-B', '默认渠道']);
    });
  });

  test('真实进程在 current 发布前后崩溃时，重启只能看到完整 old 或完整 new snapshot', async () => {
    await withTemp('limcode-multi-window-crash-', async (paths, rootPath) => {
      const oldState = addBundle(createEmptyClientState(), 'crash');
      oldState.conversations[0].title = 'old';
      await commitSkeleton(paths, createEmptyClientState(), oldState);
      const lockPath = path.join(paths.clientStateSkeletonRootPath, 'transaction.lock');

      const before = spawnWorker('skeleton-crash', rootPath, 'before-current', 'snapshotWritten', 86);
      await before.completed;
      await fs.rm(lockPath, { force: true }); // owner 进程已退出，模拟 lock recovery 完成
      assert.equal((await loadCurrentSkeleton(paths)).conversations[0].title, 'old');

      const after = spawnWorker('skeleton-crash', rootPath, 'after-current', 'currentWritten', 86);
      await after.completed;
      await fs.rm(lockPath, { force: true });
      assert.equal((await loadCurrentSkeleton(paths)).conversations[0].title, 'after-current');
    });
  });

  test('收尾恢复 multi-window vscode mock', () => restore());
}
