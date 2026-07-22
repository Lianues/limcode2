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

  toString() {
    return `file://${this.fsPath.replaceAll('\\', '/')}`;
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

async function runWorker(rootPath, prefix, count) {
  const restore = installVscodeMock();
  try {
    const { saveRecordStore } = require('../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');
    const root = MockUri.file(rootPath);
    const index = MockUri.joinPath(root, 'index.json');
    const records = Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      value: `${prefix}:${index}`,
      updatedAt: Date.now()
    }));
    await saveRecordStore(root, index, records, 'record', (record) => record.id, { pruneMissing: true });
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
      else reject(new Error(`record-store worker ${prefix} failed (${code}): ${stderr}`));
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
  test('不同进程并发全量保存同一 record store 后索引不会指向被 prune 的文件', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-'));
    try {
      await Promise.all([
        spawnWorker(tempRoot, 'alpha', 180),
        spawnWorker(tempRoot, 'beta', 180)
      ]);

      const index = JSON.parse(await fs.readFile(path.join(tempRoot, 'index.json'), 'utf8'));
      assert.equal(index.records.length, 180);
      const prefixes = new Set(index.records.map((record) => record.id.split('-')[0]));
      assert.equal(prefixes.size, 1);
      assert.ok(prefixes.has('alpha') || prefixes.has('beta'));

      for (const entry of index.records) {
        const filePath = path.join(tempRoot, ...entry.file.split('/'));
        const recordFile = JSON.parse(await fs.readFile(filePath, 'utf8'));
        assert.equal(recordFile.record.id, entry.id);
      }
      await assert.rejects(fs.access(path.join(tempRoot, 'index.json.lock')));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('reader 读旧 index 后 writer prune 删除文件时重试到新 index', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-reader-retry-'));
    const restore = installVscodeMock();
    let recordStore;
    try {
      recordStore = require('../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');
      const root = MockUri.file(tempRoot);
      const index = MockUri.joinPath(root, 'index.json');
      const records = [
        { id: 'a', value: 'old-a' },
        { id: 'b', value: 'old-b' }
      ];
      await recordStore.saveRecordStore(root, index, records, 'record', (record) => record.id, { pruneMissing: true });

      let pruned = false;
      recordStore.__recordStoreTestHooks.afterLoadIndexBeforeReadFiles = async () => {
        if (pruned) return;
        pruned = true;
        await recordStore.saveRecordStore(root, index, [{ id: 'b', value: 'new-b' }], 'record', (record) => record.id, { pruneMissing: true });
      };
      const loaded = await recordStore.loadRecordStore(root, index, 'record');
      assert.deepEqual(loaded, [{ id: 'b', value: 'new-b' }]);

      await recordStore.saveRecordStore(root, index, records, 'record', (record) => record.id, { pruneMissing: true });
      pruned = false;
      const byIds = await recordStore.loadRecordStoreByIds(root, index, 'record', ['a', 'b']);
      assert.deepEqual(byIds, [{ id: 'b', value: 'new-b' }]);
    } finally {
      if (recordStore) recordStore.__recordStoreTestHooks.afterLoadIndexBeforeReadFiles = undefined;
      restore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
}
