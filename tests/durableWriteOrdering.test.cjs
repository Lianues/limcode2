const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  writeFileAtomicDurable,
  writeFileAtomicDurableSync,
  writeFileDurable
} = require('../dist/extension/backend/capabilities/vscodeStorage/durableWrite.js');

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-durable-'));
}

async function removeTempDir(target) {
  await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * 记录异步写入路径上的 fsync 与 rename 调用顺序。
 *
 * 只包装 fsp.open 返回的 FileHandle.sync，不替换 fs.writeFile 的调用形态 ——
 * 实现刻意保留 fs.writeFile(path, data) 就是为了让这类注入点继续有效。
 */
function trackAsyncDurability() {
  const events = [];
  const originalOpen = fsp.open;
  const originalRename = fsp.rename;

  fsp.open = async function patchedOpen(target, ...rest) {
    const handle = await originalOpen.call(this, target, ...rest);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push({ kind: 'fsync', target: path.resolve(String(target)) });
      return originalSync();
    };
    return handle;
  };
  fsp.rename = async function patchedRename(from, to) {
    events.push({ kind: 'rename', target: path.resolve(String(from)), to: path.resolve(String(to)) });
    return originalRename.call(this, from, to);
  };

  return {
    events,
    restore() {
      fsp.open = originalOpen;
      fsp.rename = originalRename;
    }
  };
}

function trackSyncDurability() {
  const events = [];
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;

  fs.fsyncSync = function patchedFsyncSync(fd) {
    events.push({ kind: 'fsync', fd });
    return originalFsync.call(this, fd);
  };
  fs.renameSync = function patchedRenameSync(from, to) {
    events.push({ kind: 'rename', target: path.resolve(String(from)), to: path.resolve(String(to)) });
    return originalRename.call(this, from, to);
  };

  return {
    events,
    restore() {
      fs.fsyncSync = originalFsync;
      fs.renameSync = originalRename;
    }
  };
}

test('原子写在 rename 之前 fsync 数据文件', async () => {
  const tempRoot = await makeTempDir();
  const tracker = trackAsyncDurability();
  try {
    const target = path.join(tempRoot, 'index.json');
    await writeFileAtomicDurable(target, JSON.stringify({ ok: true }));

    const fsyncIndex = tracker.events.findIndex((event) => event.kind === 'fsync');
    const renameIndex = tracker.events.findIndex(
      (event) => event.kind === 'rename' && event.to === path.resolve(target)
    );

    assert.notEqual(fsyncIndex, -1, '临时文件必须被 fsync，否则掉电后目标文件会变成全零');
    assert.notEqual(renameIndex, -1, '必须通过 rename 发布，而不是就地覆盖目标文件');
    // 顺序是这次修复的全部意义：先确认内容落盘，再让文件名指向它。
    assert.ok(fsyncIndex < renameIndex, 'fsync 必须发生在 rename 之前');

    // 被 fsync 的是待发布的临时文件，而不是目标文件本身。
    assert.ok(tracker.events[fsyncIndex].target.endsWith('.tmp'));
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { ok: true });
  } finally {
    tracker.restore();
    await removeTempDir(tempRoot);
  }
});

test('同步原子写同样先 fsync 再 rename', async () => {
  const tempRoot = await makeTempDir();
  const tracker = trackSyncDurability();
  try {
    const target = path.join(tempRoot, 'shutdown.json');
    writeFileAtomicDurableSync(target, JSON.stringify({ shutdown: true }));

    const fsyncIndex = tracker.events.findIndex((event) => event.kind === 'fsync');
    const renameIndex = tracker.events.findIndex(
      (event) => event.kind === 'rename' && event.to === path.resolve(target)
    );

    assert.notEqual(fsyncIndex, -1, 'shutdown 路径的同步写也必须 fsync');
    assert.notEqual(renameIndex, -1);
    assert.ok(fsyncIndex < renameIndex, 'fsync 必须发生在 rename 之前');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { shutdown: true });
  } finally {
    tracker.restore();
    await removeTempDir(tempRoot);
  }
});

test('平台不支持 fsync 时写入仍然成功，不把可写变成硬失败', async () => {
  const tempRoot = await makeTempDir();
  const originalOpen = fsp.open;
  let rejectedSyncCount = 0;
  try {
    fsp.open = async function patchedOpen(target, ...rest) {
      const handle = await originalOpen.call(this, target, ...rest);
      handle.sync = async () => {
        rejectedSyncCount += 1;
        const error = new Error('EPERM: operation not permitted, fsync');
        error.code = 'EPERM';
        throw error;
      };
      return handle;
    };

    // 网络盘、部分容器挂载与 WSL 互操作路径都可能拒绝 fsync。
    // 此时应当退化为原来的「write + rename」而不是让写入直接失败。
    const atomicTarget = path.join(tempRoot, 'atomic.json');
    await writeFileAtomicDurable(atomicTarget, JSON.stringify({ atomic: 1 }));
    assert.deepEqual(JSON.parse(await fsp.readFile(atomicTarget, 'utf8')), { atomic: 1 });

    const inPlaceTarget = path.join(tempRoot, 'in-place.json');
    await writeFileDurable(inPlaceTarget, JSON.stringify({ inPlace: 1 }));
    assert.deepEqual(JSON.parse(await fsp.readFile(inPlaceTarget, 'utf8')), { inPlace: 1 });

    assert.ok(rejectedSyncCount >= 2, '两次写入都应该尝试过 fsync');
  } finally {
    fsp.open = originalOpen;
    await removeTempDir(tempRoot);
  }
});

test('rename 持续失败时抛出原始错误并清理临时文件', async () => {
  const tempRoot = await makeTempDir();
  const originalRename = fsp.rename;
  try {
    const target = path.join(tempRoot, 'locked.json');
    await fsp.writeFile(target, JSON.stringify({ existing: true }), 'utf8');

    fsp.rename = async function patchedRename(from, to) {
      if (path.resolve(String(to)) === path.resolve(target)) {
        const error = new Error('injected rename failure');
        error.code = 'EACCES';
        throw error;
      }
      return originalRename.call(this, from, to);
    };

    await assert.rejects(
      writeFileAtomicDurable(target, JSON.stringify({ replacement: true })),
      // 错误必须原样抛出：上层的 isTransientFileBusyError 依赖 error.code。
      (error) => error.code === 'EACCES'
    );

    // 旧内容完好，且不留 .tmp 残留（没有任何恢复逻辑会去读它们，堆积只会占空间）。
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { existing: true });
    const leftovers = (await fsp.readdir(tempRoot)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    fsp.rename = originalRename;
    await removeTempDir(tempRoot);
  }
});
