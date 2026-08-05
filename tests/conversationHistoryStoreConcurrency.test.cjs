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
  assert.match(index.manifestRevision, /^sha256:[a-f0-9]{64}$/);
  const generationRoot = path.join(root, 'generations', index.generation);
  const manifest = JSON.parse(await fs.readFile(path.join(generationRoot, 'manifest.json'), 'utf8'));
  const commit = JSON.parse(await fs.readFile(path.join(generationRoot, 'committed.json'), 'utf8'));
  assert.equal(manifest.revision, index.manifestRevision);
  assert.equal(commit.manifestRevision, index.manifestRevision);
  const { revision: _revision, ...manifestPayload } = manifest;
  assert.deepEqual(commit.manifest, manifestPayload);
  assert.equal(manifest.total, index.total);
  assert.deepEqual(manifest.pages, index.pages);
  assert.equal(Number.isSafeInteger(manifest.commitSequence), true);
  assert.equal(manifest.commitSequence >= 1, true);

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
  return { index, manifest, commit, entries, originLinks };
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

  // 注意：这里刻意不创建任何 generation 副本。index 损坏且无副本可回退时，
  // 行为仍然是「拒绝写入 + UI 告警返回空」；有副本可回退的场景见下方两个恢复用例。
  test('损坏或未知结构的 index 且无副本可回退时拒绝写入且 UI 读取仅告警返回空', async () => {
    for (const [label, content, pattern] of [
      ['损坏 JSON', 'not-json{{{', /index (?:JSON|content) is invalid/i],
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
          /index is missing.*(?:projection traces|recoverable committed generation)/i
        );
        await assert.rejects(fs.access(historyIndexPath(tempRoot)));
      } finally {
        await removeTempRoot(tempRoot);
      }
    }
  });

  test('index 引用的页面损坏时用保留 generation 恢复而不是永久拒写', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 3; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`seed-${index}`, index));
      }
      const before = await readCanonicalProjection(tempRoot);
      const pagePath = path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/'));
      // 掉电后 rename 的元数据已落盘、内容还在页缓存里的典型形态：文件在，但内容不是合法 JSON。
      await fs.writeFile(pagePath, 'not-json{{{', 'utf8');

      let warned = false;
      const originalWarn = console.warn;
      console.warn = (...args) => { warned = true; originalWarn(...args); };
      try {
        const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
        // 当前一代整页读不出来时回退到上一代仍然完好的副本，而不是把侧边栏刷成空白。
        assert.deepEqual(page.entries.map((entry) => entry.id).sort(), ['seed-0', 'seed-1']);
        assert.equal(warned, true);
      } finally {
        console.warn = originalWarn;
      }

      // 写入也不再永久瘫痪：基于恢复出来的基线继续发布新一代。
      await upsertConversationHistoryEntryInStore(paths, makeEntry('new-after-corrupt-page', 100));
      const healed = await readCanonicalProjection(tempRoot);
      assert.notEqual(healed.index.generation, before.index.generation);
      assert.deepEqual(
        new Set(healed.entries.map((entry) => entry.id)),
        new Set(['seed-0', 'seed-1', 'new-after-corrupt-page'])
      );
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('合法 JSON 但页面 schema 损坏时也会进入恢复路径', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('schema-retained', 1));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('schema-current-only', 2));
      const before = await readCanonicalProjection(tempRoot);
      const pagePath = path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/'));
      const pageFile = JSON.parse(await fs.readFile(pagePath, 'utf8'));
      pageFile.entries = 'schema-corrupt-but-valid-json';
      await fs.writeFile(pagePath, JSON.stringify(pageFile), 'utf8');

      const recoveredPage = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      assert.deepEqual(recoveredPage.entries.map((entry) => entry.id), ['schema-retained']);

      await upsertConversationHistoryEntryInStore(paths, makeEntry('after-schema-corruption', 3));
      const healed = await readCanonicalProjection(tempRoot);
      assert.deepEqual(
        new Set(healed.entries.map((entry) => entry.id)),
        new Set(['schema-retained', 'after-schema-corruption'])
      );
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('页面恢复使用当前 manifest 的 entryIds，不复活旧快照中已删除会话', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('kept-entry', 1));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('deleted-entry', 2));
      await removeConversationHistoryEntryFromStore(paths, 'deleted-entry');
      const before = await readCanonicalProjection(tempRoot);
      assert.deepEqual(before.entries.map((entry) => entry.id), ['kept-entry']);
      const pagePath = path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/'));
      await fs.writeFile(pagePath, 'not-json{{{', 'utf8');

      const recovered = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      assert.deepEqual(recovered.entries.map((entry) => entry.id), ['kept-entry']);
      assert.equal(recovered.entries.some((entry) => entry.id === 'deleted-entry'), false);

      await upsertConversationHistoryEntryInStore(paths, makeEntry('after-deletion-recovery', 3));
      const healed = await readCanonicalProjection(tempRoot);
      assert.deepEqual(
        new Set(healed.entries.map((entry) => entry.id)),
        new Set(['kept-entry', 'after-deletion-recovery'])
      );
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('index missing 或 schema 损坏时从已提交 generation 恢复并继续写入', async () => {
    for (const mode of ['missing', 'schema-invalid']) {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
      try {
        const paths = makePaths(tempRoot);
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`${mode}-seed-0`, 1));
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`${mode}-seed-1`, 2));
        const indexPath = historyIndexPath(tempRoot);
        if (mode === 'missing') {
          await fs.rm(indexPath, { force: true });
        } else {
          const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
          index.unknownField = true;
          await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');
        }

        const recoveredPage = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
        assert.deepEqual(
          new Set(recoveredPage.entries.map((entry) => entry.id)),
          new Set([`${mode}-seed-0`, `${mode}-seed-1`])
        );

        await upsertConversationHistoryEntryInStore(paths, makeEntry(`${mode}-after-recovery`, 3));
        const healed = await readCanonicalProjection(tempRoot);
        assert.deepEqual(
          new Set(healed.entries.map((entry) => entry.id)),
          new Set([`${mode}-seed-0`, `${mode}-seed-1`, `${mode}-after-recovery`])
        );
      } finally {
        await removeTempRoot(tempRoot);
      }
    }
  });

  test('根 index 已写但 committed marker 提交失败时拒绝 mutation 并回退上一代', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('marker-committed', 1));
      const committed = await readCanonicalProjection(tempRoot);

      __conversationHistoryStoreTestHooks.beforeCommitGeneration = () => {
        throw new Error('injected committed marker publish failure');
      };
      await assert.rejects(
        upsertConversationHistoryEntryInStore(paths, makeEntry('marker-uncommitted', 2)),
        /injected committed marker publish failure/i
      );
      __conversationHistoryStoreTestHooks.beforeCommitGeneration = undefined;

      const uncommittedIndex = JSON.parse(await fs.readFile(historyIndexPath(tempRoot), 'utf8'));
      const uncommittedRoot = path.join(historyRoot(tempRoot), 'generations', uncommittedIndex.generation);
      await assert.rejects(fs.access(path.join(uncommittedRoot, 'committed.json')));

      const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      assert.deepEqual(page.entries.map((entry) => entry.id), ['marker-committed']);
      assert.equal(page.entries.some((entry) => entry.id === 'marker-uncommitted'), false);

      await upsertConversationHistoryEntryInStore(paths, makeEntry('marker-after-recovery', 3));
      const healed = await readCanonicalProjection(tempRoot);
      assert.deepEqual(
        new Set(healed.entries.map((entry) => entry.id)),
        new Set(['marker-committed', 'marker-after-recovery'])
      );
      assert.notEqual(healed.index.generation, committed.index.generation);
      await assert.rejects(fs.access(uncommittedRoot));
    } finally {
      __conversationHistoryStoreTestHooks.beforeCommitGeneration = undefined;
      await removeTempRoot(tempRoot);
    }
  });

  test('committed marker 内嵌 manifest 可在 manifest.json 损坏时恢复完整当前代', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('embedded-manifest-0', 1));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('embedded-manifest-1', 2));
      const before = await readCanonicalProjection(tempRoot);
      const manifestPath = path.join(historyRoot(tempRoot), 'generations', before.index.generation, 'manifest.json');
      await fs.writeFile(manifestPath, 'not-json{{{', 'utf8');

      const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      assert.deepEqual(
        new Set(page.entries.map((entry) => entry.id)),
        new Set(['embedded-manifest-0', 'embedded-manifest-1'])
      );
      await upsertConversationHistoryEntryInStore(paths, makeEntry('embedded-manifest-after', 3));
      const healed = await readCanonicalProjection(tempRoot);
      assert.deepEqual(
        new Set(healed.entries.map((entry) => entry.id)),
        new Set(['embedded-manifest-0', 'embedded-manifest-1', 'embedded-manifest-after'])
      );
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('index.json 被掉电写成全零时仍能从保留 generation 自愈', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 3; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`seed-${index}`, index));
      }
      const before = await readCanonicalProjection(tempRoot);

      // 复刻真实事故：文件大小不变，内容被 NUL 填满。此前这会让侧边栏永久空白且写入永久报错。
      const indexPath = historyIndexPath(tempRoot);
      const originalSize = (await fs.stat(indexPath)).size;
      await fs.writeFile(indexPath, Buffer.alloc(originalSize, 0));

      const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      // 只有 index 坏了，generation 里的页还是完整的，应该一条都不丢。
      assert.deepEqual(
        new Set(page.entries.map((entry) => entry.id)),
        new Set(['seed-0', 'seed-1', 'seed-2'])
      );

      await upsertConversationHistoryEntryInStore(paths, makeEntry('after-zeroed-index', 100));
      const healed = await readCanonicalProjection(tempRoot);
      assert.notEqual(healed.index.generation, before.index.generation);
      assert.deepEqual(
        new Set(healed.entries.map((entry) => entry.id)),
        new Set(['seed-0', 'seed-1', 'seed-2', 'after-zeroed-index'])
      );
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('系统时钟回拨后按 commitSequence 恢复真正最新的已提交 generation', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    const generationIds = [
      '20990101-000000-000-aaaaaaaa',
      '20200101-000000-000-bbbbbbbb'
    ];
    try {
      const paths = makePaths(tempRoot);
      __conversationHistoryStoreTestHooks.createGenerationId = () => generationIds.shift();
      await upsertConversationHistoryEntryInStore(paths, makeEntry('clock-before-rollback', 1));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('clock-after-rollback', 2));
      __conversationHistoryStoreTestHooks.createGenerationId = undefined;

      const before = await readCanonicalProjection(tempRoot);
      assert.equal(before.index.generation, '20200101-000000-000-bbbbbbbb');
      assert.equal(before.manifest.commitSequence, 2);

      const indexPath = historyIndexPath(tempRoot);
      await fs.writeFile(indexPath, Buffer.alloc((await fs.stat(indexPath)).size, 0));
      const recovered = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      assert.deepEqual(
        new Set(recovered.entries.map((entry) => entry.id)),
        new Set(['clock-before-rollback', 'clock-after-rollback'])
      );
    } finally {
      __conversationHistoryStoreTestHooks.createGenerationId = undefined;
      await removeTempRoot(tempRoot);
    }
  });

  test('没有任何完好副本可用时维持 fail-closed，不拿空列表覆盖', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('only-seed', 1));
      const before = await readCanonicalProjection(tempRoot);
      const pagePath = path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/'));
      await fs.writeFile(pagePath, 'not-json{{{', 'utf8');

      // 唯一一代的页坏了、又没有更早的副本可合并：宁可拒写，也不能把空列表发布成新一代。
      await assert.rejects(
        upsertConversationHistoryEntryInStore(paths, makeEntry('must-not-publish', 2)),
        /page is unreadable/i
      );
      const indexAfter = JSON.parse(await fs.readFile(historyIndexPath(tempRoot), 'utf8'));
      assert.equal(indexAfter.generation, before.index.generation);
      assert.equal(indexAfter.total, 1);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('页面读取瞬时失败（ioError）时维持 fail-closed，恢复后一条不丢', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 3; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`seed-${index}`, index));
      }
      const before = await readCanonicalProjection(tempRoot);
      const pagePath = path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/'));
      const pageBackup = await fs.readFile(pagePath);

      // 用同名目录顶替页文件，制造真实的读取失败（EISDIR / EPERM）。这类故障与内容损坏
      // 有本质区别：页本体完好，只是这一刻读不到（杀软扫描、句柄耗尽都是同类场景）。
      await fs.rm(pagePath, { force: true });
      await fs.mkdir(pagePath, { recursive: true });

      // 绝不能拿「跳过坏页」拼出来的投影当写入基线：那会把本可以读回来的会话永久删掉。
      await assert.rejects(
        upsertConversationHistoryEntryInStore(paths, makeEntry('must-not-publish', 100)),
        /page is unreadable \(ioError\)/i
      );
      const indexAfter = JSON.parse(await fs.readFile(historyIndexPath(tempRoot), 'utf8'));
      assert.equal(indexAfter.generation, before.index.generation);
      assert.equal(indexAfter.total, 3);

      // 瞬时故障消失后写入恢复正常，三条种子全在 —— 这正是 fail-closed 保住的东西。
      await fs.rm(pagePath, { recursive: true, force: true });
      await fs.writeFile(pagePath, pageBackup);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('after-transient-io-error', 100));
      const healed = await readCanonicalProjection(tempRoot);
      assert.deepEqual(
        new Set(healed.entries.map((entry) => entry.id)),
        new Set(['seed-0', 'seed-1', 'seed-2', 'after-transient-io-error'])
      );
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('缺页且无任何完好副本时也维持 fail-closed', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('only-seed', 1));
      const before = await readCanonicalProjection(tempRoot);
      assert.equal(before.index.total, 1);

      // 唯一一代的页丢了，也没有更早的副本可合并：此时恢复结果为空，
      // 而 index.total 却是 1 —— 把空列表发布成新一代等于抹掉整份会话列表。
      await fs.rm(path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/')), { force: true });

      await assert.rejects(
        upsertConversationHistoryEntryInStore(paths, makeEntry('must-not-publish', 2)),
        /page is missing/i
      );
      const indexAfter = JSON.parse(await fs.readFile(historyIndexPath(tempRoot), 'utf8'));
      assert.equal(indexAfter.generation, before.index.generation);
      assert.equal(indexAfter.total, 1);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('index 引用的页面缺失时用保留 generation 恢复并允许继续写入', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('retained-before-missing', 1));
      const retained = await readCanonicalProjection(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('lost-current-page-entry', 2));
      const broken = await readCanonicalProjection(tempRoot);
      assert.notEqual(broken.index.generation, retained.index.generation);

      const missingPagePath = path.join(historyRoot(tempRoot), ...broken.index.pages[0].file.split('/'));
      await fs.rm(missingPagePath, { force: true });

      const recoveredPage = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 10 });
      assert.deepEqual(recoveredPage.entries.map((entry) => entry.id), ['retained-before-missing']);

      await upsertConversationHistoryEntryInStore(paths, makeEntry('after-missing-page', 3));
      const healed = await readCanonicalProjection(tempRoot);
      assert.deepEqual(new Set(healed.entries.map((entry) => entry.id)), new Set(['retained-before-missing', 'after-missing-page']));
      assert.notEqual(healed.index.generation, broken.index.generation);
      // 缺页的 generation 作为 previous 仍会暂时保留用于排障；恢复扫描会按 manifest
      // 的精确页清单校验并跳过它，不会把残缺 generation 当作 checkpoint。
      assert.equal((await listGenerationIds(tempRoot)).includes(broken.index.generation), true);
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

      // 根 index 随后损坏时，也只能恢复已成功发布的 generation，不能让已报告失败的 mutation 复活。
      const indexPath = historyIndexPath(tempRoot);
      await fs.writeFile(indexPath, Buffer.alloc((await fs.stat(indexPath)).size, 0));
      const recovered = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 100 });
      assert.equal(recovered.pageInfo.total, 50);
      assert.equal(recovered.entries.some((entry) => entry.id === 'new-after-failed-index'), false);
    } finally {
      __conversationHistoryStoreTestHooks.beforePublishIndex = undefined;
      await removeTempRoot(tempRoot);
    }
  });

  test('恢复扫描拒绝只有连续前缀页的未提交 generation', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 51; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`prefix-seed-${index}`, index));
      }
      const before = await readCanonicalProjection(tempRoot);
      assert.equal(before.index.pages.length, 2);

      const fakeGeneration = '20991231-235959-999-ffffffff';
      const fakePagesRoot = path.join(historyRoot(tempRoot), 'generations', fakeGeneration, 'pages');
      await fs.mkdir(fakePagesRoot, { recursive: true });
      const firstPage = JSON.parse(await fs.readFile(path.join(historyRoot(tempRoot), ...before.index.pages[0].file.split('/')), 'utf8'));
      firstPage.generation = fakeGeneration;
      await fs.writeFile(path.join(fakePagesRoot, '000000.json'), JSON.stringify(firstPage), 'utf8');

      const indexPath = historyIndexPath(tempRoot);
      await fs.writeFile(indexPath, Buffer.alloc((await fs.stat(indexPath)).size, 0));
      const recovered = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: 100 });
      assert.equal(recovered.pageInfo.total, 51);
      assert.deepEqual(
        new Set(recovered.entries.map((entry) => entry.id)),
        new Set(before.entries.map((entry) => entry.id))
      );
    } finally {
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

  test('generation 清理读取 committed marker 遇 ioError 时 fail-closed，不删除任何候选', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    const originalReadFile = fs.readFile;
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('cleanup-io-1', 1));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('cleanup-io-2', 2));
      await upsertConversationHistoryEntryInStore(paths, makeEntry('cleanup-io-3', 3));
      const oldestGeneration = (await listGenerationIds(tempRoot))[0];
      const blockedMarker = path.resolve(path.join(historyRoot(tempRoot), 'generations', oldestGeneration, 'committed.json'));

      fs.readFile = async function patchedReadFile(target, ...rest) {
        if (path.resolve(String(target)) === blockedMarker) {
          const error = new Error('injected committed marker ioError');
          error.code = 'EIO';
          throw error;
        }
        return originalReadFile.call(this, target, ...rest);
      };
      await upsertConversationHistoryEntryInStore(paths, makeEntry('cleanup-io-4', 4));
      fs.readFile = originalReadFile;

      await fs.access(path.join(historyRoot(tempRoot), 'generations', oldestGeneration));
    } finally {
      fs.readFile = originalReadFile;
      await removeTempRoot(tempRoot);
    }
  });

  test('generation 清理按显式时间桶保留 checkpoint 并删除过期 generation', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, makeEntry('gen-1', 1));
      const gen1 = (await readCanonicalProjection(tempRoot)).index.generation;
      await upsertConversationHistoryEntryInStore(paths, makeEntry('gen-2', 2));
      const gen2 = (await readCanonicalProjection(tempRoot)).index.generation;
      assert.notEqual(gen2, gen1);
      assert.deepEqual(new Set(await listGenerationIds(tempRoot)), new Set([gen1, gen2]));

      // current 与 previous 之外，最近时间桶还会保留一份已提交 checkpoint。
      await upsertConversationHistoryEntryInStore(paths, makeEntry('gen-3', 3));
      const gen3 = (await readCanonicalProjection(tempRoot)).index.generation;
      assert.notEqual(gen3, gen2);
      assert.deepEqual(new Set(await listGenerationIds(tempRoot)), new Set([gen1, gen2, gen3]));

      // 最长时间桶之外的 generation 仍然照常清理，避免无限堆积。
      const expiredGeneration = '20260101-010203-004-000000ff';
      await fs.mkdir(path.join(historyRoot(tempRoot), 'generations', expiredGeneration, 'pages'), { recursive: true });
      await upsertConversationHistoryEntryInStore(paths, makeEntry('gen-4', 4));
      const remaining = new Set(await listGenerationIds(tempRoot));
      assert.equal(remaining.has(expiredGeneration), false);
      assert.equal(remaining.has(gen3), true);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('收尾恢复 vscode mock', () => {
    restore();
  });
}
