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
    // 极简实现：仅覆盖测试所需的 file:// URI
    const withoutScheme = uri.replace(/^file:\/\//, '');
    return { fsPath: withoutScheme, path: withoutScheme };
  }

  toString() {
    return `file://${this.fsPath.replaceAll('\\\\', '/')}`;
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

function makeEntry(id, updatedAt) {
  return {
    id,
    title: `title-${id}`,
    preview: '',
    messageCount: 1,
    status: 'completed',
    updatedAt,
    isRunning: false
  };
}

async function readScopeIds(rootPath, scopeDir) {
  const indexPath = path.join(rootPath, 'conversation-history', scopeDir, 'index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const ids = [];
  for (const page of index.pages) {
    const pageFile = JSON.parse(await fs.readFile(path.join(rootPath, 'conversation-history', scopeDir, ...page.file.split('/')), 'utf8'));
    ids.push(...pageFile.entries.map((entry) => entry.id));
  }
  return { total: index.total, ids };
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

function spawnWorker(rootPath, prefix, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--worker', rootPath, prefix, String(count)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`conversation-history worker ${prefix} failed (${code}): ${stderr}`));
    });
  });
}

if (process.argv[2] === '--worker') {
  runWorker(process.argv[3], process.argv[4], Number(process.argv[5]))
    .then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
} else {
  const restore = installVscodeMock();
  const {
    loadConversationHistoryPageFromStore,
    upsertConversationHistoryEntryInStore,
    removeConversationHistoryEntryFromStore
  } = require('../dist/extension/backend/capabilities/vscodeStorage/conversationHistoryStore.js');

  test('进程内并发 upsert 不会互相覆盖丢条目', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      const count = 60;
      // 无锁时这批并发“全量读 → 改 → 全量写”几乎必然互相覆盖，最终 total 远小于 count。
      await Promise.all(Array.from({ length: count }, (_, index) =>
        upsertConversationHistoryEntryInStore(paths, makeEntry(`inproc-${index}`, index))
      ));

      const { total, ids } = await readScopeIds(tempRoot, 'all');
      assert.equal(total, count);
      assert.equal(new Set(ids).size, count);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('不同进程并发 upsert 同一 history store 不丢条目', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      await Promise.all([
        spawnWorker(tempRoot, 'alpha', 40),
        spawnWorker(tempRoot, 'beta', 40)
      ]);

      const { total, ids } = await readScopeIds(tempRoot, 'all');
      assert.equal(total, 80);
      assert.equal(new Set(ids).size, 80);
      await assert.rejects(fs.access(path.join(tempRoot, 'conversation-history', 'mutation.lock')));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('索引引用的页文件损坏时写入被拒绝，且磁盘上现有数据不被覆盖', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      for (let index = 0; index < 3; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`seed-${index}`, index));
      }

      const pagePath = path.join(tempRoot, 'conversation-history', 'all', 'pages', '000000.json');
      await fs.writeFile(pagePath, 'not-json{{{', 'utf8');

      // 写路径：损坏必须中止（解析错误直接传播），不允许基于空投影回写抹掉剩余数据。
      await assert.rejects(
        upsertConversationHistoryEntryInStore(paths, makeEntry('new-1', 100))
      );
      const index = JSON.parse(await fs.readFile(path.join(tempRoot, 'conversation-history', 'all', 'index.json'), 'utf8'));
      assert.equal(index.total, 3);

      // 读路径（UI 展示）保持宽松：返回空页而不是抛错。
      const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, cursor: '0', limit: 50 });
      assert.equal(page.entries.length, 0);
      assert.equal(page.pageInfo.total, 3);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('重写后清理不再被索引引用的孤儿页文件', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      const count = 60; // 超过单页 50 条，产生 pages/000001.json
      await Promise.all(Array.from({ length: count }, (_, index) =>
        upsertConversationHistoryEntryInStore(paths, makeEntry(`prune-${index}`, index))
      ));
      const pagesDir = path.join(tempRoot, 'conversation-history', 'all', 'pages');
      assert.ok((await fs.readdir(pagesDir)).length >= 2);

      // 删到只剩 1 条后索引应只剩 1 页，旧页文件应被清理。
      for (let index = 1; index < count; index += 1) {
        await removeConversationHistoryEntryFromStore(paths, `prune-${index}`);
      }
      const { total, ids } = await readScopeIds(tempRoot, 'all');
      assert.equal(total, 1);
      assert.deepEqual(ids, ['prune-0']);
      assert.deepEqual((await fs.readdir(pagesDir)).sort(), ['000000.json']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('进程崩溃残留的 stale 锁能被自动接管', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      const historyDir = path.join(tempRoot, 'conversation-history');
      await fs.mkdir(historyDir, { recursive: true });
      // 模拟进程崩溃留下的锁：pid 已不存在。
      await fs.writeFile(path.join(historyDir, 'mutation.lock'), JSON.stringify({ pid: 4194304, createdAt: Date.now() }), 'utf8');

      await upsertConversationHistoryEntryInStore(paths, makeEntry('after-stale-lock', 1));
      const { total, ids } = await readScopeIds(tempRoot, 'all');
      assert.equal(total, 1);
      assert.deepEqual(ids, ['after-stale-lock']);
      await assert.rejects(fs.access(path.join(historyDir, 'mutation.lock')));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('会话项目归属变化时从旧 scope 迁移到新 scope', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      await upsertConversationHistoryEntryInStore(paths, { ...makeEntry('moving-1', 1), projectFolderUri: 'file:///proj-a' });
      await upsertConversationHistoryEntryInStore(paths, { ...makeEntry('moving-1', 2), projectFolderUri: 'file:///proj-b' });

      const projectsDir = path.join(tempRoot, 'conversation-history', 'projects');
      const scopeDirs = await fs.readdir(projectsDir);
      const dirA = scopeDirs.find((name) => name.startsWith('proj-a-'));
      const dirB = scopeDirs.find((name) => name.startsWith('proj-b-'));
      assert.ok(dirA && dirB);
      assert.equal((await readScopeIds(tempRoot, path.join('projects', dirA))).total, 0);
      assert.deepEqual((await readScopeIds(tempRoot, path.join('projects', dirB))).ids, ['moving-1']);
      assert.deepEqual((await readScopeIds(tempRoot, 'all')).ids, ['moving-1']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('upsert 与 remove 混合并发后索引保持一致', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      // 先串行种入 20 条将被删除的旧条目。
      for (let index = 0; index < 20; index += 1) {
        await upsertConversationHistoryEntryInStore(paths, makeEntry(`old-${index}`, index));
      }
      // 混合并发：新增 30 条 + 删除 20 条旧条目。
      await Promise.all([
        ...Array.from({ length: 30 }, (_, index) =>
          upsertConversationHistoryEntryInStore(paths, makeEntry(`fresh-${index}`, 100 + index))),
        ...Array.from({ length: 20 }, (_, index) =>
          removeConversationHistoryEntryFromStore(paths, `old-${index}`))
      ]);

      const { total, ids } = await readScopeIds(tempRoot, 'all');
      assert.equal(total, 30);
      assert.equal(new Set(ids).size, 30);
      assert.ok(ids.every((id) => id.startsWith('fresh-')));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('旧格式数据整体重写时保留未被覆盖的旧页文件', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      // 手工构造旧版本（schemaVersion 999）的两页数据。
      const allDir = path.join(tempRoot, 'conversation-history', 'all');
      await fs.mkdir(path.join(allDir, 'pages'), { recursive: true });
      const legacyPage = (entries) => JSON.stringify({ schemaVersion: 999, savedAt: '2020-01-01T00:00:00.000Z', scope: { kind: 'all' }, entries, originLinks: [] });
      await fs.writeFile(path.join(allDir, 'pages', '000000.json'), legacyPage([makeEntry('legacy-0', 1)]), 'utf8');
      await fs.writeFile(path.join(allDir, 'pages', '000001.json'), legacyPage([makeEntry('legacy-1', 2)]), 'utf8');
      await fs.writeFile(path.join(allDir, 'index.json'), JSON.stringify({
        schemaVersion: 999,
        savedAt: '2020-01-01T00:00:00.000Z',
        scope: { kind: 'all' },
        pageSize: 50,
        total: 2,
        pages: [{ file: 'pages/000000.json', count: 1 }, { file: 'pages/000001.json', count: 1 }]
      }), 'utf8');

      // 首次写入：按既有行为整体重写为新格式，但不得删除未被同名覆盖的旧页。
      await upsertConversationHistoryEntryInStore(paths, makeEntry('modern-0', 100));
      const { total, ids } = await readScopeIds(tempRoot, 'all');
      assert.equal(total, 1);
      assert.deepEqual(ids, ['modern-0']);
      await fs.access(path.join(allDir, 'pages', '000001.json')); // 旧页仍在，可人工恢复
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('缺少 originLinks 字段的旧页文件可读且写入时自愈', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-'));
    try {
      const paths = makePaths(tempRoot);
      // 手工构造同 schemaVersion 但无 originLinks 字段的旧格式页（字段是后加的）。
      const allDir = path.join(tempRoot, 'conversation-history', 'all');
      await fs.mkdir(path.join(allDir, 'pages'), { recursive: true });
      await fs.writeFile(path.join(allDir, 'pages', '000000.json'), JSON.stringify({
        schemaVersion: 1,
        savedAt: '2026-07-10T00:00:00.000Z',
        scope: { kind: 'all' },
        entries: [makeEntry('legacy-nolinks', 1)]
      }), 'utf8');
      await fs.writeFile(path.join(allDir, 'index.json'), JSON.stringify({
        schemaVersion: 1,
        savedAt: '2026-07-10T00:00:00.000Z',
        scope: { kind: 'all' },
        pageSize: 50,
        total: 1,
        pages: [{ file: 'pages/000000.json', count: 1 }]
      }), 'utf8');

      // 读路径：旧页可读，条目可见。
      const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, cursor: '0', limit: 50 });
      assert.deepEqual(page.entries.map((entry) => entry.id), ['legacy-nolinks']);
      assert.deepEqual(page.originLinks, []);

      // 写路径：不被旧页阻断，重写后字段补全。
      await upsertConversationHistoryEntryInStore(paths, makeEntry('modern-nolinks', 2));
      const { total, ids } = await readScopeIds(tempRoot, 'all');
      assert.equal(total, 2);
      assert.ok(ids.includes('legacy-nolinks') && ids.includes('modern-nolinks'));
      const healed = JSON.parse(await fs.readFile(path.join(allDir, 'pages', '000000.json'), 'utf8'));
      assert.ok(Array.isArray(healed.originLinks));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('收尾恢复 vscode mock', () => {
    restore();
  });
}
