const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
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

function installVscodeMock(workspaceRoot = process.cwd()) {
  const mock = {
    Uri: MockUri,
    workspace: {
      workspaceFolders: [{ uri: MockUri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }]
    },
    window: {
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    commands: { executeCommand: async () => undefined }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mock;
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => { Module._load = originalLoad; };
}

function commandPaths(rootPath) {
  return {
    backgroundCommandsRootPath: rootPath,
    backgroundCommandsIndexPath: path.join(rootPath, 'index.json')
  };
}

function outputCommand(text) {
  const safe = text.replace(/'/g, "''");
  if (process.platform === 'win32') return `Write-Output '${safe}'`;
  return `printf '%s\\n' '${safe}'`;
}

function slowCommand(text, milliseconds = 1500) {
  const safe = text.replace(/'/g, "''");
  if (process.platform === 'win32') return `Start-Sleep -Milliseconds ${milliseconds}; Write-Output '${safe}'`;
  return `sleep ${Math.max(1, Math.ceil(milliseconds / 1000))}; printf '%s\\n' '${safe}'`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRecordByProcessId(rootPath, processId) {
  const index = JSON.parse(await fs.readFile(path.join(rootPath, 'index.json'), 'utf8'));
  const entry = index.records.find((candidate) => candidate.processId === processId);
  if (!entry) return undefined;
  return JSON.parse(await fs.readFile(path.join(rootPath, 'records', entry.file), 'utf8'));
}

async function waitForRecord(rootPath, processId, predicate, timeoutMs = 5000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await readRecordByProcessId(rootPath, processId);
    if (last && predicate(last)) return last;
    await delay(50);
  }
  throw new Error(`record ${processId} did not reach expected state; last=${JSON.stringify(last)}`);
}

async function removeTempRoot(target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code)) throw error;
      await delay(30 * attempt);
    }
  }
}

async function runWorker(rootPath, prefix, count) {
  const restore = installVscodeMock(rootPath);
  try {
    const { createCommandCapability } = require('../dist/extension/backend/capabilities/commandRunner.js');
    const capability = createCommandCapability({ paths: () => commandPaths(rootPath) });
    for (let index = 0; index < count; index += 1) {
      const result = await capability.run(
        { command: outputCommand(`${prefix}-${index}`), cwd: rootPath, foregroundWaitMs: 0 },
        undefined,
        undefined,
        { maxOutputLines: 20, maxOutputChars: 2000 }
      );
      if (result.status !== 'running' || !result.processId) {
        throw new Error(`worker ${prefix} command ${index} did not enter background: ${JSON.stringify(result)}`);
      }
    }
    await delay(750);
    capability.dispose();
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
      else reject(new Error(`background command worker ${prefix} failed (${code}): ${stderr}`));
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
  process.on('exit', restore);
  const { createCommandCapability } = require('../dist/extension/backend/capabilities/commandRunner.js');

  test('多进程并发保存不同 background command records 不丢 index', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bg-concurrency-'));
    try {
      await fs.mkdir(tempRoot, { recursive: true });
      await Promise.all([
        spawnWorker(tempRoot, 'alpha', 8),
        spawnWorker(tempRoot, 'beta', 8)
      ]);

      const index = JSON.parse(await fs.readFile(path.join(tempRoot, 'index.json'), 'utf8'));
      assert.equal(index.version, 1);
      assert.equal(index.records.length, 16);
      assert.equal(new Set(index.records.map((entry) => entry.processId)).size, 16);
      for (const entry of index.records) {
        const record = JSON.parse(await fs.readFile(path.join(tempRoot, 'records', entry.file), 'utf8'));
        assert.equal(record.processId, entry.processId);
        assert.match(record.command, /alpha-|beta-/);
      }
      await assert.rejects(fs.access(path.join(tempRoot, 'index.json.lock')));
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('损坏 background command index 拒绝空回写覆盖', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bg-invalid-index-'));
    try {
      const indexPath = path.join(tempRoot, 'index.json');
      await fs.mkdir(tempRoot, { recursive: true });
      await fs.writeFile(indexPath, '{not-json', 'utf8');
      const capability = createCommandCapability({ paths: () => commandPaths(tempRoot) });
      const result = await capability.run(
        { command: outputCommand('invalid-index'), cwd: tempRoot, foregroundWaitMs: 0 },
        undefined,
        undefined,
        { maxOutputLines: 20, maxOutputChars: 2000 }
      );
      assert.equal(result.status, 'running');
      await delay(500);
      capability.dispose();
      assert.equal(await fs.readFile(indexPath, 'utf8'), '{not-json');
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('原子写 rename 故障不会破坏旧 index，tmp 会被清理', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bg-atomic-'));
    const indexPath = path.join(tempRoot, 'index.json');
    const originalRename = fsSync.renameSync;
    let capability;
    let processId = '';
    try {
      await fs.mkdir(tempRoot, { recursive: true });
      await fs.writeFile(indexPath, JSON.stringify({ version: 1, records: [] }, null, 2), 'utf8');
      fsSync.renameSync = function patchedRename(source, target) {
        if (path.resolve(target) === path.resolve(indexPath)) {
          const error = new Error('injected index rename failure');
          error.code = 'EACCES';
          throw error;
        }
        return originalRename.apply(this, arguments);
      };
      capability = createCommandCapability({ paths: () => commandPaths(tempRoot) });
      const result = await capability.run(
        { command: slowCommand('atomic-index'), cwd: tempRoot, foregroundWaitMs: 0 },
        undefined,
        undefined,
        { maxOutputLines: 20, maxOutputChars: 2000 }
      );
      processId = result.processId || '';
      assert.equal(result.status, 'running');
      const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      assert.deepEqual(index, { version: 1, records: [] });
      const tmpFiles = (await fs.readdir(tempRoot)).filter((name) => name.endsWith('.tmp'));
      assert.deepEqual(tmpFiles, []);
    } finally {
      fsSync.renameSync = originalRename;
      if (capability && processId) capability.kill(processId);
      capability?.dispose();
      await removeTempRoot(tempRoot);
    }
  });

  test('paths provider 暂不可用时不永久标记 loaded，恢复后可持久化待保存 handle', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bg-paths-'));
    let available = false;
    try {
      const capability = createCommandCapability({ paths: () => available ? commandPaths(tempRoot) : undefined });
      const result = await capability.run(
        { command: slowCommand('paths-recovered', 800), cwd: tempRoot, foregroundWaitMs: 0 },
        undefined,
        undefined,
        { maxOutputLines: 20, maxOutputChars: 2000 }
      );
      assert.equal(result.status, 'running');
      assert.ok(result.processId);
      await assert.rejects(fs.access(path.join(tempRoot, 'index.json')));

      available = true;
      const output = capability.readOutput(result.processId, { maxOutputLines: 20, maxOutputChars: 2000 }, { consume: false });
      assert.equal(output.processId, result.processId);
      const index = JSON.parse(await fs.readFile(path.join(tempRoot, 'index.json'), 'utf8'));
      assert.ok(index.records.some((entry) => entry.processId === result.processId));
      capability.kill(result.processId);
      capability.dispose();
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('orphan dead-owner persisted running records are marked exited under the same locked index update', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bg-running-load-'));
    try {
      const recordsRoot = path.join(tempRoot, 'records');
      await fs.mkdir(recordsRoot, { recursive: true });
      const now = Date.now();
      const record = {
        version: 1,
        processId: 'persisted-running',
        ownerInstanceId: 'dead-owner-instance',
        ownerPid: 99999999,
        heartbeatAt: now,
        kind: process.platform === 'win32' ? 'powershell' : 'bash',
        command: 'old command',
        cwd: tempRoot,
        stdout: 'before',
        stderr: '',
        droppedStdoutChars: 0,
        droppedStderrChars: 0,
        status: 'running',
        exitCode: null,
        killed: false,
        startedAt: now - 1000,
        updatedAt: now - 500
      };
      await fs.writeFile(path.join(recordsRoot, 'running.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await fs.writeFile(path.join(tempRoot, 'index.json'), `${JSON.stringify({
        version: 1,
        records: [{ processId: record.processId, file: 'running.json', status: 'running', updatedAt: record.updatedAt }]
      }, null, 2)}\n`, 'utf8');

      const capability = createCommandCapability({ paths: () => commandPaths(tempRoot) });
      const output = capability.readOutput(record.processId, { maxOutputLines: 20, maxOutputChars: 2000 }, { consume: false });
      assert.equal(output.status, 'exited');
      assert.equal(output.exitCode, 1);
      assert.match(output.stderr, /持有者已停止|心跳超时|异常终止/);

      const stored = JSON.parse(await fs.readFile(path.join(recordsRoot, 'running.json'), 'utf8'));
      assert.equal(stored.status, 'exited');
      const index = JSON.parse(await fs.readFile(path.join(tempRoot, 'index.json'), 'utf8'));
      assert.equal(index.records[0].status, 'exited');
      capability.dispose();
    } finally {
      await removeTempRoot(tempRoot);
    }
  });

  test('live external owner keeps running record from being exited, killed, or consumed; terminal state is refreshed later', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bg-live-owner-'));
    let ownerCapability;
    let observerCapability;
    try {
      ownerCapability = createCommandCapability({ paths: () => commandPaths(tempRoot) });
      const started = await ownerCapability.run(
        { command: slowCommand('live-owner-complete', 900), cwd: tempRoot, foregroundWaitMs: 0 },
        undefined,
        undefined,
        { maxOutputLines: 20, maxOutputChars: 2000 }
      );
      assert.equal(started.status, 'running');
      assert.ok(started.processId);
      await waitForRecord(tempRoot, started.processId, (record) => record.status === 'running' && record.ownerPid === process.pid && record.heartbeatAt > 0);

      observerCapability = createCommandCapability({ paths: () => commandPaths(tempRoot) });
      const observed = observerCapability.readOutput(started.processId, { maxOutputLines: 20, maxOutputChars: 2000 });
      assert.equal(observed.status, 'running');
      let stored = await readRecordByProcessId(tempRoot, started.processId);
      assert.equal(stored.status, 'running');

      const killAttempt = observerCapability.kill(started.processId);
      assert.equal(killAttempt.status, 'running');
      stored = await readRecordByProcessId(tempRoot, started.processId);
      assert.equal(stored.status, 'running');

      await waitForRecord(tempRoot, started.processId, (record) => record.status === 'exited');
      const terminal = observerCapability.readOutput(started.processId, { maxOutputLines: 20, maxOutputChars: 2000 }, { consume: false });
      assert.equal(terminal.status, 'exited');
      assert.match(terminal.stdout, /live-owner-complete/);
    } finally {
      observerCapability?.dispose();
      ownerCapability?.dispose();
      await removeTempRoot(tempRoot);
    }
  });
}
