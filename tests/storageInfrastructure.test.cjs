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

function lockTestOptions(lockPath, overrides = {}) {
  return {
    lockPath,
    waitMs: 5_000,
    staleMs: 60_000,
    pollIntervalMs: 5,
    invalidMetadataWaitMs: 10,
    maxRetries: 12,
    retryDelayMs: 5,
    ...overrides
  };
}

async function appendLockLog(logPath, entry) {
  let entries = [];
  try {
    entries = JSON.parse(await fs.readFile(logPath, 'utf8'));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  entries.push(entry);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, JSON.stringify(entries), 'utf8');
}

async function runLockWorker(rootPath, prefix, count) {
  const restore = installVscodeMock();
  try {
    const { withStorageResourceLock } = require('../dist/extension/backend/capabilities/vscodeStorage/storageResourceLock.js');
    const resource = MockUri.file(path.join(rootPath, 'shared-resource.json'));
    const lockPath = path.join(rootPath, 'shared-resource.lock');
    const logPath = path.join(rootPath, 'shared-log.json');
    for (let index = 0; index < count; index += 1) {
      await withStorageResourceLock(resource, async () => {
        await appendLockLog(logPath, `${prefix}-${index}`);
        await delay(5);
      }, lockTestOptions(lockPath));
    }
  } finally {
    restore();
  }
}

async function runHoldLockWorker(rootPath, holdMs) {
  const restore = installVscodeMock();
  try {
    const { withStorageResourceLock } = require('../dist/extension/backend/capabilities/vscodeStorage/storageResourceLock.js');
    const resource = MockUri.file(path.join(rootPath, 'held-resource.json'));
    const lockPath = path.join(rootPath, 'held-resource.lock');
    const logPath = path.join(rootPath, 'held-log.json');
    await withStorageResourceLock(resource, async () => {
      await appendLockLog(logPath, 'first-start');
      await delay(holdMs);
      await appendLockLog(logPath, 'first-end');
    }, lockTestOptions(lockPath, { waitMs: 3_000, staleMs: 60, heartbeatIntervalMs: 10, pollIntervalMs: 5 }));
  } finally {
    restore();
  }
}

function spawnLockWorker(rootPath, prefix, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--lock-worker', rootPath, prefix, String(count)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`storage lock worker ${prefix} failed (${code}): ${stderr}`));
    });
  });
}

function spawnHoldLockWorker(rootPath, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--hold-lock-worker', rootPath, String(holdMs)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`storage hold-lock worker failed (${code}): ${stderr}`));
    });
  });
}

async function waitForLogEntry(logPath, entry, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = JSON.parse(await fs.readFile(logPath, 'utf8'));
      if (entries.includes(entry)) return entries;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for log entry ${entry}`);
}

if (process.argv[2] === '--lock-worker') {
  runLockWorker(process.argv[3], process.argv[4], Number(process.argv[5]))
    .then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
} else if (process.argv[2] === '--hold-lock-worker') {
  runHoldLockWorker(process.argv[3], Number(process.argv[4]))
    .then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
} else {
  const restore = installVscodeMock();
  const { readJsonStrict } = require('../dist/extension/backend/capabilities/vscodeStorage/json.js');
  const { withStorageResourceLock } = require('../dist/extension/backend/capabilities/vscodeStorage/storageResourceLock.js');
  const {
    cleanupInactiveStorageGenerations,
    createStorageGenerationId,
    createStorageGenerationLocation,
    getStorageGenerationRelativePath,
    isSafeStorageGenerationId,
    listStorageGenerations
  } = require('../dist/extension/backend/capabilities/vscodeStorage/storageGeneration.js');
  const { loadRecordStore } = require('../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');

  test('严格 JSON 读取区分 missing / invalid / ok', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-json-'));
    try {
      const missing = await readJsonStrict(MockUri.file(path.join(tempRoot, 'missing.json')));
      assert.equal(missing.status, 'missing');

      const invalidPath = path.join(tempRoot, 'invalid.json');
      await fs.writeFile(invalidPath, 'not-json{{{', 'utf8');
      const invalid = await readJsonStrict(MockUri.file(invalidPath));
      assert.equal(invalid.status, 'invalid');

      const emptyPath = path.join(tempRoot, 'empty.json');
      await fs.writeFile(emptyPath, '  \n', 'utf8');
      const empty = await readJsonStrict(MockUri.file(emptyPath));
      assert.equal(empty.status, 'invalid');

      const okPath = path.join(tempRoot, 'ok.json');
      await fs.writeFile(okPath, JSON.stringify({ ok: true }), 'utf8');
      const ok = await readJsonStrict(MockUri.file(okPath));
      assert.equal(ok.status, 'ok');
      assert.deepEqual(ok.value, { ok: true });
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('通用资源锁在同进程内按资源 URI 串行', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-inproc-'));
    try {
      const resource = MockUri.file(path.join(tempRoot, 'resource.json'));
      const lockPath = path.join(tempRoot, 'resource.lock');
      let active = 0;
      let maxActive = 0;
      await Promise.all(Array.from({ length: 8 }, (_, index) =>
        withStorageResourceLock(resource, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(15 + index);
          active -= 1;
        }, lockTestOptions(lockPath))
      ));

      assert.equal(maxActive, 1);
      await assert.rejects(fs.access(lockPath));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('通用资源锁使用 lockfile 跨进程串行', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-xproc-'));
    try {
      await Promise.all([
        spawnLockWorker(tempRoot, 'alpha', 35),
        spawnLockWorker(tempRoot, 'beta', 35)
      ]);

      const entries = JSON.parse(await fs.readFile(path.join(tempRoot, 'shared-log.json'), 'utf8'));
      assert.equal(entries.length, 70);
      assert.equal(new Set(entries).size, 70);
      await assert.rejects(fs.access(path.join(tempRoot, 'shared-resource.lock')));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('通用资源锁同进程 action 超过 stale 但 heartbeat 保持活锁不被第二 writer 抢占', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-heartbeat-inproc-'));
    try {
      const resource = MockUri.file(path.join(tempRoot, 'resource.json'));
      const lockPath = path.join(tempRoot, 'resource.lock');
      const options = lockTestOptions(lockPath, { waitMs: 2_000, staleMs: 50, heartbeatIntervalMs: 10, pollIntervalMs: 5 });
      const order = [];
      let releaseFirst;
      let first;
      const firstEntered = new Promise((resolve) => {
        first = withStorageResourceLock(resource, async () => {
          order.push('first-start');
          resolve();
          await new Promise((release) => { releaseFirst = release; });
          order.push('first-end');
        }, options);
      });
      await firstEntered;

      let secondEntered = false;
      const second = withStorageResourceLock(resource, async () => {
        secondEntered = true;
        order.push('second');
      }, options);
      await delay(120);
      assert.equal(secondEntered, false, 'second writer must not enter while first heartbeat is fresh beyond staleMs');
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(order, ['first-start', 'first-end', 'second']);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('通用资源锁跨进程 action 超过 stale 但 heartbeat 保持活锁不被第二 writer 抢占', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-heartbeat-xproc-'));
    try {
      const logPath = path.join(tempRoot, 'held-log.json');
      const first = spawnHoldLockWorker(tempRoot, 180);
      await waitForLogEntry(logPath, 'first-start');

      const resource = MockUri.file(path.join(tempRoot, 'held-resource.json'));
      const lockPath = path.join(tempRoot, 'held-resource.lock');
      const options = lockTestOptions(lockPath, { waitMs: 2_000, staleMs: 60, heartbeatIntervalMs: 10, pollIntervalMs: 5 });
      let secondEntered = false;
      const second = withStorageResourceLock(resource, async () => {
        secondEntered = true;
        await appendLockLog(logPath, 'second');
      }, options);

      await delay(130);
      assert.equal(secondEntered, false, 'second process-local writer must wait even after staleMs while first process heartbeats');
      await Promise.all([first, second]);
      const entries = JSON.parse(await fs.readFile(logPath, 'utf8'));
      assert.deepEqual(entries, ['first-start', 'first-end', 'second']);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  for (const [label, content] of [['空', ''], ['损坏', '{not-json']]) {
    test(`通用资源锁可在短等待后恢复${label} metadata lockfile`, async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-recover-'));
      try {
        const resource = MockUri.file(path.join(tempRoot, 'resource.json'));
        const lockPath = path.join(tempRoot, 'resource.lock');
        await fs.writeFile(lockPath, content, 'utf8');
        await delay(20);

        let acquired = false;
        await withStorageResourceLock(resource, async () => {
          acquired = true;
        }, lockTestOptions(lockPath));

        assert.equal(acquired, true);
        await assert.rejects(fs.access(lockPath));
      } finally {
        await removeTempRoot(tempRoot);
      }
    });
  }

  test('通用资源锁 release 前校验 owner token，避免误删他人 lockfile', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-owner-'));
    try {
      const resource = MockUri.file(path.join(tempRoot, 'resource.json'));
      const lockPath = path.join(tempRoot, 'resource.lock');

      await assert.rejects(
        withStorageResourceLock(resource, async () => {
          await fs.writeFile(lockPath, `${JSON.stringify({
            ownerToken: 'different-owner-token',
            pid: process.pid,
            createdAt: Date.now(),
            heartbeatAt: Date.now(),
            resource: 'file://external-owner'
          })}\n`, 'utf8');
        }, lockTestOptions(lockPath)),
        /owner token mismatch/i
      );

      const metadata = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      assert.equal(metadata.ownerToken, 'different-owner-token');
      await fs.rm(lockPath, { force: true });
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('recordStore 普通读取只在内存 repair，不回写 index 文件', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-record-read-repair-'));
    try {
      await fs.mkdir(path.join(tempRoot, 'records'), { recursive: true });
      await fs.writeFile(path.join(tempRoot, 'records', 'a.json'), JSON.stringify({
        schemaVersion: 1,
        savedAt: '2026-07-22T00:00:00.000Z',
        record: { id: 'a', value: 1 }
      }, null, 2), 'utf8');

      const indexPath = path.join(tempRoot, 'index.json');
      const originalIndex = `${JSON.stringify({
        schemaVersion: 1,
        savedAt: '2026-07-22T00:00:00.000Z',
        records: [
          { id: 'ignored-invalid-file', file: '../bad.json', updatedAt: '2026-07-22T00:00:00.000Z' },
          { id: 'a', file: 'records/a.json', updatedAt: '2026-07-22T00:00:00.000Z' },
          { id: 'a', file: 'records/a.json', updatedAt: '2026-07-22T00:00:01.000Z' }
        ]
      }, null, 2)}\n`;
      await fs.writeFile(indexPath, originalIndex, 'utf8');

      const records = await loadRecordStore(MockUri.file(tempRoot), MockUri.file(indexPath), 'record');
      assert.deepEqual(records, [{ id: 'a', value: 1 }]);
      assert.equal(await fs.readFile(indexPath, 'utf8'), originalIndex);
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('storage generation 提供安全 id、路径、列出与清理非活跃 generation', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-generation-'));
    try {
      const generated = createStorageGenerationId(new Date(Date.UTC(2026, 6, 22, 1, 2, 3, 4)));
      assert.match(generated, /^20260722-010203-004-[a-f0-9]{8}$/);
      assert.equal(isSafeStorageGenerationId(generated), true);
      assert.throws(() => getStorageGenerationRelativePath('../bad'));

      const root = MockUri.file(tempRoot);
      const activeId = '20260722-010203-004-00000001';
      const inactiveId = '20260722-010203-005-00000002';
      const active = createStorageGenerationLocation(root, activeId);
      const inactive = createStorageGenerationLocation(root, inactiveId);
      await fs.mkdir(active.rootUri.fsPath, { recursive: true });
      await fs.mkdir(inactive.rootUri.fsPath, { recursive: true });
      await fs.mkdir(path.join(tempRoot, 'generations', 'unsafe-generation'), { recursive: true });

      const listed = await listStorageGenerations(root);
      assert.deepEqual(listed.map((generation) => generation.id), [activeId, inactiveId]);

      const result = await cleanupInactiveStorageGenerations(root, [activeId]);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.deleted.map((generation) => generation.id), [inactiveId]);
      await fs.access(active.rootUri.fsPath);
      await assert.rejects(fs.access(inactive.rootUri.fsPath));
      await fs.access(path.join(tempRoot, 'generations', 'unsafe-generation'));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('收尾恢复 vscode mock', () => {
    restore();
  });
}
