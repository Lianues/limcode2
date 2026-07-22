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
  }

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static joinPath(base, ...segments) {
    return new MockUri(path.join(base.fsPath, ...segments));
  }

  static parse(uri) {
    const withoutScheme = uri.replace(/^file:\/\//, '');
    return { fsPath: withoutScheme, path: withoutScheme };
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
        delete: (uri) => fs.rm(uri.fsPath, { recursive: true, force: false }),
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

function makePaths(rootPath) {
  return { conversationHistoryRootUri: MockUri.joinPath(MockUri.file(rootPath), 'conversation-history') };
}

function makeEntry(id, updatedAt, extra = {}) {
  return {
    id,
    title: `title-${id}`,
    preview: '',
    messageCount: 1,
    status: 'complete',
    updatedAt,
    isRunning: false,
    ...extra
  };
}

function makeOriginLink(conversationId, sourceConversationId, updatedAt = Date.now()) {
  return {
    id: `origin-${conversationId}`,
    conversationId,
    originKind: 'agent',
    sourceConversationId,
    createdAt: updatedAt,
    updatedAt
  };
}

function historyRoot(rootPath) {
  return path.join(rootPath, 'conversation-history');
}

function historyIndexPath(rootPath) {
  return path.join(historyRoot(rootPath), 'index.json');
}

async function readCanonicalProjection(rootPath) {
  const root = historyRoot(rootPath);
  const index = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8'));
  assert.equal(index.schemaVersion, 1);
  assert.match(index.generation, /^\d{8}-\d{6}-\d{3}-[a-f0-9]{8}$/);
  assert.equal(index.pages.reduce((total, page) => total + page.count, 0), index.total);

  const entries = [];
  const originLinks = [];
  for (let pageIndex = 0; pageIndex < index.pages.length; pageIndex += 1) {
    const pageRecord = index.pages[pageIndex];
    const expectedFile = `generations/${index.generation}/pages/${String(pageIndex).padStart(6, '0')}.json`;
    assert.equal(pageRecord.generation, index.generation);
    assert.equal(pageRecord.file, expectedFile);
    const page = JSON.parse(await fs.readFile(path.join(root, ...pageRecord.file.split('/')), 'utf8'));
    assert.equal(page.schemaVersion, 1);
    assert.equal(page.generation, index.generation);
    assert.equal(page.entries.length, pageRecord.count);
    entries.push(...page.entries);
    originLinks.push(...page.originLinks);
  }
  assert.equal(entries.length, index.total);
  return { index, entries, originLinks };
}

async function listGenerationIds(rootPath) {
  try {
    const entries = await fs.readdir(path.join(historyRoot(rootPath), 'generations'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function assertNoLegacyScopeRoots(rootPath) {
  for (const name of ['all', 'projects', 'unbound']) {
    await assert.rejects(fs.access(path.join(historyRoot(rootPath), name)));
  }
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
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code)) throw error;
      await delay(25 * attempt);
    }
  }
}

async function runWorker(rootPath, prefix, count) {
  const restore = installVscodeMock();
  try {
    const { upsertConversationHistoryEntryInStore } = require('../dist/extension/backend/capabilities/vscodeStorage/conversationHistoryStore.js');
    const paths = makePaths(rootPath);
    for (let index = 0; index < count; index += 1) {
      await upsertConversationHistoryEntryInStore(paths, makeEntry(`${prefix}-${index}`, index));
    }
  } finally {
    restore();
  }
}

async function runRemoveWorker(rootPath, prefix, count) {
  const restore = installVscodeMock();
  try {
    const { removeConversationHistoryEntryFromStore } = require('../dist/extension/backend/capabilities/vscodeStorage/conversationHistoryStore.js');
    const paths = makePaths(rootPath);
    for (let index = 0; index < count; index += 1) {
      await removeConversationHistoryEntryFromStore(paths, `${prefix}-${index}`);
    }
  } finally {
    restore();
  }
}

function spawnWorker(rootPath, prefix, count) {
  return spawnHistoryWorker('--worker', rootPath, prefix, count);
}

function spawnRemoveWorker(rootPath, prefix, count) {
  return spawnHistoryWorker('--remove-worker', rootPath, prefix, count);
}

function spawnHistoryWorker(mode, rootPath, prefix, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, mode, rootPath, prefix, String(count)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`conversation-history worker ${mode}:${prefix} failed (${code}): ${stderr}`));
    });
  });
}

if (process.argv[2] === '--worker') {
  runWorker(process.argv[3], process.argv[4], Number(process.argv[5]))
    .then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
} else if (process.argv[2] === '--remove-worker') {
  runRemoveWorker(process.argv[3], process.argv[4], Number(process.argv[5]))
    .then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
} else {
  const restore = installVscodeMock();
  const store = require('../dist/extension/backend/capabilities/vscodeStorage/conversationHistoryStore.js');
  const {
    loadConversationHistoryPageFromStore,
    upsertConversationHistoryEntryInStore,
    removeConversationHistoryEntryFromStore,
    __conversationHistoryStoreTestHooks
  } = store;

  test('进程内并发 upsert 写入单一 canonical projection 且不创建 scope 投影', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      const count = 60;
      await Promise.all(Array.from({ length: count }, (_, index) =>
        upsertConversationHistoryEntryInStore(paths, makeEntry(`inproc-${index}`, index))
      ));

      const { index, entries } = await readCanonicalProjection(tempRoot);
      assert.equal(index.total, count);
      assert.equal(new Set(entries.map((entry) => entry.id)).size, count);
      assert.ok(index.pages.length >= 2);
      await assertNoLegacyScopeRoots(tempRoot);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('不同进程并发 upsert 同一 canonical history store 不丢条目', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      await Promise.all([
        spawnWorker(tempRoot, 'alpha', 40),
        spawnWorker(tempRoot, 'beta', 40)
      ]);

      const { index, entries } = await readCanonicalProjection(tempRoot);
      assert.equal(index.total, 80);
      assert.equal(new Set(entries.map((entry) => entry.id)).size, 80);
      await assertNoLegacyScopeRoots(tempRoot);
      await assert.rejects(fs.access(path.join(tempRoot, 'conversation-history.lock')));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('upsert 与 remove 混合并发后 canonical index 保持一致', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 20; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`old-${index}`, index));
      }

      await Promise.all([
        ...Array.from({ length: 30 }, (_, index) =>
          upsertConversationHistoryEntryInStore(paths, makeEntry(`fresh-${index}`, 100 + index))),
        ...Array.from({ length: 20 }, (_, index) =>
          removeConversationHistoryEntryFromStore(paths, `old-${index}`))
      ]);

      const { index, entries } = await readCanonicalProjection(tempRoot);
      const ids = entries.map((entry) => entry.id);
      assert.equal(index.total, 30);
      assert.equal(new Set(ids).size, 30);
      assert.ok(ids.every((id) => id.startsWith('fresh-')));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('跨进程 upsert 与 remove 混合并发后 canonical index 保持一致', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 20; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`old-${index}`, index));
      }

      await Promise.all([
        spawnWorker(tempRoot, 'fresh-a', 25),
        spawnWorker(tempRoot, 'fresh-b', 25),
        spawnRemoveWorker(tempRoot, 'old', 20)
      ]);

      const { index, entries } = await readCanonicalProjection(tempRoot);
      const ids = entries.map((entry) => entry.id);
      assert.equal(index.total, 50);
      assert.equal(new Set(ids).size, 50);
      assert.ok(ids.every((id) => id.startsWith('fresh-')));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('scope 由 canonical projection 按 projectFolderUri 精确派生并过滤 originLinks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('project-a-parent', 10, {
        projectFolderUri: 'file:///proj-a',
        projectName: 'proj-a'
      }));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('project-a-child', 20, {
        projectFolderUri: 'file:///proj-a',
        projectName: 'proj-a'
      }), makeOriginLink('project-a-child', 'project-a-parent', 20));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('project-b', 30, {
        projectFolderUri: 'file:///proj-b',
        projectName: 'proj-b'
      }));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('unbound-1', 40));

      const all = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      assert.equal(all.pageInfo.total, 4);
      assert.deepEqual(new Set(all.entries.map((entry) => entry.id)), new Set(['project-a-parent', 'project-a-child', 'project-b', 'unbound-1']));

      const unbound = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'unbound' }, limit: 10 });
      assert.deepEqual(unbound.entries.map((entry) => entry.id), ['unbound-1']);
      assert.deepEqual(unbound.originLinks, []);

      const projectA = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'project', folderUri: 'file:///proj-a' }, limit: 10 });
      assert.deepEqual(projectA.entries.map((entry) => entry.id), ['project-a-parent', 'project-a-child']);
      assert.deepEqual(projectA.originLinks.map((link) => link.conversationId), ['project-a-child']);

      const projectALimited = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'project', folderUri: 'file:///proj-a' }, cursor: '0', limit: 1 });
      assert.equal(projectALimited.pageInfo.pageSize, 1);
      assert.equal(projectALimited.pageInfo.total, 2);
      assert.deepEqual(projectALimited.entries.map((entry) => entry.id), ['project-a-parent', 'project-a-child']);
      assert.deepEqual(projectALimited.originLinks.map((link) => link.conversationId), ['project-a-child']);

      const projectB = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'project', folderUri: 'file:///proj-b' }, limit: 10 });
      assert.deepEqual(projectB.entries.map((entry) => entry.id), ['project-b']);
      assert.deepEqual(projectB.originLinks, []);

      const projectAWithDifferentUri = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'project', folderUri: 'file:///proj-a/' }, limit: 10 });
      assert.deepEqual(projectAWithDifferentUri.entries, []);
      assert.equal(projectAWithDifferentUri.pageInfo.total, 0);
      await assertNoLegacyScopeRoots(tempRoot);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('损坏或未知结构的 index 拒绝写入且 UI 读取仅告警返回空', async () => {
    for (const [label, content, pattern] of [
      ['损坏 JSON', 'not-json{{{', /index JSON is invalid/i],
      ['未知结构', JSON.stringify({ schemaVersion: 1, savedAt: '2026-07-22T00:00:00.000Z', scope: { kind: 'all' }, pages: [] }), /index.*(generation|structure|invalid|unknown)/i]
    ]) {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
      try {
        const paths = makePaths(tempRoot);
        await fs.mkdir(historyRoot(tempRoot), { recursive: true });
        await fs.writeFile(historyIndexPath(tempRoot), content, 'utf8');

        await assert.rejects(
          upsertConversationHistoryEntryInStore(paths, makeEntry(`after-${label}`, 1)),
          pattern
        );
        assert.equal(await fs.readFile(historyIndexPath(tempRoot), 'utf8'), content);

        let warned = false;
        const originalWarn = console.warn;
        console.warn = (...args) => { warned = true; originalWarn(...args); };
        try {
          const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
          assert.deepEqual(page.entries, []);
          assert.equal(page.pageInfo.total, 0);
          assert.equal(warned, true);
        } finally {
          console.warn = originalWarn;
        }
      } finally {
        await removeTempRoot(tempRoot);
      }
    }
  });

  test('index missing 但已有 generation、旧 scope 或未知痕迹时拒绝写入', async () => {
    for (const [label, setup] of [
      ['generation', async (root) => {
        await fs.mkdir(path.join(historyRoot(root), 'generations', '20260722-010203-004-00000001', 'pages'), { recursive: true });
      }],
      ['旧 all scope', async (root) => {
        await fs.mkdir(path.join(historyRoot(root), 'all'), { recursive: true });
        await fs.writeFile(path.join(historyRoot(root), 'all', 'index.json'), '{}', 'utf8');
      }],
      ['未知文件', async (root) => {
        await fs.mkdir(historyRoot(root), { recursive: true });
        await fs.writeFile(path.join(historyRoot(root), 'mystery.json'), '{}', 'utf8');
      }]
    ]) {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
      try {
        const paths = makePaths(tempRoot);
        await setup(tempRoot);
        await assert.rejects(
          upsertConversationHistoryEntryInStore(paths, makeEntry(`after-${label}`, 1)),
          /index is missing.*projection traces/i
        );
        await assert.rejects(fs.access(historyIndexPath(tempRoot)));
      } finally {
        await removeTempRoot(tempRoot);
      }
    }
  });

  test('index 引用的页面损坏时拒绝写入，UI 读取告警返回空且不回写', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 3; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`seed-${index}`, index));
      }
      const before = await readCanonicalProjection(tempRoot);
      const pagePath = path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/'));
      await fs.writeFile(pagePath, 'not-json{{{', 'utf8');

      await assert.rejects(
        upsertConversationHistoryEntryInStore(paths, makeEntry('new-after-corrupt-page', 100)),
        /page JSON is invalid/i
      );
      const indexAfter = JSON.parse(await fs.readFile(historyIndexPath(tempRoot), 'utf8'));
      assert.equal(indexAfter.generation, before.index.generation);
      assert.equal(indexAfter.total, 3);

      let warned = false;
      const originalWarn = console.warn;
      console.warn = (...args) => { warned = true; originalWarn(...args); };
      try {
        const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
        assert.deepEqual(page.entries, []);
        assert.equal(page.pageInfo.total, 0);
        assert.equal(warned, true);
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(JSON.parse(await fs.readFile(historyIndexPath(tempRoot), 'utf8')).generation, before.index.generation);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('故障注入：页面写入成功但 index 发布失败后旧 50 条仍完整', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 50; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`old-${index}`, index));
      }
      const before = await readCanonicalProjection(tempRoot);
      assert.equal(before.index.total, 50);

      __conversationHistoryStoreTestHooks.beforePublishIndex = () => {
        throw new Error('injected index publish failure');
      };
      await assert.rejects(
        upsertConversationHistoryEntryInStore(paths, makeEntry('new-after-failed-index', 100)),
        /injected index publish failure/i
      );
      __conversationHistoryStoreTestHooks.beforePublishIndex = undefined;

      const after = await readCanonicalProjection(tempRoot);
      assert.equal(after.index.generation, before.index.generation);
      assert.equal(after.index.total, 50);
      assert.deepEqual(new Set(after.entries.map((entry) => entry.id)), new Set(before.entries.map((entry) => entry.id)));
      assert.equal(after.entries.some((entry) => entry.id === 'new-after-failed-index'), false);
    } finally {
      __conversationHistoryStoreTestHooks.beforePublishIndex = undefined;
      await removeTempRoot(tempRoot);
    }
  });

  test('reader 发现 generation 变化会有限重试并返回新 generation 数据', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('retry-old', 1));
      let hookCalls = 0;
      __conversationHistoryStoreTestHooks.afterReadIndexBeforePages = async ({ attempt }) => {
        hookCalls += 1;
        if (attempt === 1) {
          await upsertConversationHistoryEntryInStore(paths, makeEntry('retry-new', 2));
        }
      };

      const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      __conversationHistoryStoreTestHooks.afterReadIndexBeforePages = undefined;

      assert.ok(hookCalls >= 2);
      assert.deepEqual(new Set(page.entries.map((entry) => entry.id)), new Set(['retry-old', 'retry-new']));
      assert.equal(page.pageInfo.total, 2);
    } finally {
      __conversationHistoryStoreTestHooks.afterReadIndexBeforePages = undefined;
      await removeTempRoot(tempRoot);
    }
  });

  test('generation 清理至少保留当前与前一代并删除更旧 generation', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('gen-1', 1));
      const gen1 = (await readCanonicalProjection(tempRoot)).index.generation;
      await upsertConversationHistoryEntryInStore(paths, makeEntry('gen-2', 2));
      const gen2 = (await readCanonicalProjection(tempRoot)).index.generation;
      assert.notEqual(gen2, gen1);
      assert.deepEqual(new Set(await listGenerationIds(tempRoot)), new Set([gen1, gen2]));

      await upsertConversationHistoryEntryInStore(paths, makeEntry('gen-3', 3));
      const gen3 = (await readCanonicalProjection(tempRoot)).index.generation;
      assert.notEqual(gen3, gen2);
      assert.deepEqual(new Set(await listGenerationIds(tempRoot)), new Set([gen2, gen3]));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('收尾恢复 vscode mock', () => {
    restore();
  });
}
