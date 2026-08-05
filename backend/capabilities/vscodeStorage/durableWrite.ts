import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 原子 + 持久化写入原语。
 *
 * 只做 `write temp -> rename` 并不足以保证崩溃安全：NTFS/ext4 都会先把 rename 的
 * 元数据变更提交到日志，而临时文件里的数据可能仍停留在页缓存中尚未回写。异常掉电后
 * 目标文件会保留正确的大小、却整块变成 NUL —— 2026-08-03 会话索引整层归零就是这么
 * 发生的。因此在 rename 之前必须对数据做 fsync，这一步不可省略。
 *
 * 目录 fsync 属于 best-effort：Windows 上对目录句柄调用 fsync 恒定返回 EPERM，而
 * NTFS 的 rename 元数据本身由 $LogFile 保证，忽略该失败是安全的；在 POSIX 上它能
 * 额外确保目录项落盘。
 *
 * 适用边界：只给「内容丢了就回不来」的数据文件用。锁文件与心跳刻意不用：它们的语义
 * 是互斥，掉电后持有者进程已经死了、锁本就应该失效，“锁文件内容完整落盘”没有价值；
 * 而加锁是每次存储写入都要走的高频路径，磁盘繁忙时 fsync 远不止几毫秒，会直接拖慢
 * 锁获取。实测：给锁文件加 fsync 会让 shadowWorktreeLock 的并行用例在全量测试负载下
 * 超出 30ms 断言窗口而失败。
 */

let atomicWriteSequence = 0;

const RENAME_MAX_ATTEMPTS = 4;
const RENAME_BASE_DELAY_MS = 10;

export function isTransientFileBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function createAtomicTempPath(fsPath: string): string {
  return `${fsPath}.${process.pid}.${Date.now()}.${atomicWriteSequence++}.tmp`;
}

/**
 * 原子发布一次写入，数据在 rename 前已 fsync 落盘。
 *
 * 失败时一律清理临时文件：没有任何恢复逻辑会去读带随机 pid/序号后缀的 .tmp，
 * 而频繁写入的索引一旦遇到持续的 rename 失败（杀软锁定等）会让它们快速堆积。
 */
export async function writeFileAtomicDurable(fsPath: string, data: Uint8Array | string): Promise<void> {
  await fsp.mkdir(path.dirname(fsPath), { recursive: true });
  const tempPath = createAtomicTempPath(fsPath);
  try {
    await writeFileDurable(tempPath, data);
    await renameWithRetry(tempPath, fsPath);
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
  await syncDirectoryBestEffort(path.dirname(fsPath));
}

/** writeFileAtomicDurable 的同步版本，供 shutdown 路径等无法 await 的场景使用。 */
export function writeFileAtomicDurableSync(fsPath: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(fsPath), { recursive: true });
  const tempPath = createAtomicTempPath(fsPath);
  try {
    writeFileDurableSync(tempPath, data);
    renameWithRetrySync(tempPath, fsPath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 清理失败不应掩盖写入阶段的原始错误。
    }
  }
  syncDirectoryBestEffortSync(path.dirname(fsPath));
}

/**
 * 写入并 fsync 单个文件，不做 rename。
 *
 * 数据写入刻意保留 fs.writeFile(path, data) 这个调用形态，而不是自己 open 后用
 * FileHandle.writeFile：后者虽然能省一次 open，却会绕过所有对 fs.writeFile 的监控与
 * 测试注入点（例如迷向写入阻塞测试），破坏可观测性。fsync 只是追加一步。
 */
export async function writeFileDurable(fsPath: string, data: Uint8Array | string): Promise<void> {
  await fsp.writeFile(fsPath, data);
  const handle = await fsp.open(fsPath, 'r+');
  try {
    await fsyncHandleBestEffort(handle, fsPath);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function writeFileDurableSync(fsPath: string, data: Uint8Array | string): void {
  fs.writeFileSync(fsPath, data);
  const fd = fs.openSync(fsPath, 'r+');
  try {
    fsyncFdBestEffort(fd, fsPath);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不应掩盖写入阶段的错误。
    }
  }
}

/**
 * fsync 失败不往上抛：部分挂载点（网络盘、某些 WSL / 容器 overlay）并不实现 fsync。
 * 若在这里抛错会把“持久化变弱”升级为“写入直接失败”，比改造前更糟。失败时退化回
 * 原有行为并告警一次，保证该改动只增不减。
 */
async function fsyncHandleBestEffort(handle: fsp.FileHandle, fsPath?: string): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    warnFsyncFailed(fsPath, error);
  }
}

function fsyncFdBestEffort(fd: number, fsPath?: string): void {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    warnFsyncFailed(fsPath, error);
  }
}

let fsyncUnsupportedWarned = false;

/** 挂载点根本不实现 fsync 时返回的错误码：这是固定结论，告警一次就够了。 */
const FSYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'ENOTTY', 'EPERM']);

function warnFsyncFailed(fsPath: string | undefined, error: unknown): void {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && FSYNC_UNSUPPORTED_CODES.has(code)) {
    if (fsyncUnsupportedWarned) return;
    fsyncUnsupportedWarned = true;
  }
  // EIO 之类是真实的磁盘故障，必须每次都说出来；若与「平台不支持」共用一个
  // warn-once 开关，用户会在数据实际已经不安全的状态下只收到过一条提示。
  console.warn(
    `[LimCode] fsync failed for storage write${fsPath ? ` (${fsPath})` : ''}; `
      + 'data durability falls back to OS flushing and may be lost on power failure.',
    error
  );
}

export async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !isTransientFileBusyError(error)) throw error;
      await delay(RENAME_BASE_DELAY_MS * (2 ** (attempt - 1)));
    }
  }
}

export function renameWithRetrySync(source: string, target: string): void {
  retryTransientFileOperationSync(() => fs.renameSync(source, target));
}

export function retryTransientFileOperationSync<T>(action: () => T, maxRetries = 6, retryDelayMs = 15): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= maxRetries || !isTransientFileBusyError(error)) throw error;
      sleepSync(retryDelayMs * attempt);
    }
  }
}

export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(1, Math.floor(milliseconds)));
}

/**
 * 目录 fsync 能把 rename 产生的目录项变更落盘，但 Windows 上没有收益：对目录句柄调用
 * fsync 实测恒定返回 EPERM，等于每次写入都多一次注定失败的 open + fsync + catch。
 * NTFS 的 rename 元数据本身由 $LogFile 保证，真正不能省的是数据 fsync，而那一步已经
 * 在 writeFileDurable 里做过了。因此按平台门控：Windows 跳过，POSIX 正常做。
 */
const DIRECTORY_FSYNC_SUPPORTED = process.platform !== 'win32';

async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(dirPath, 'r');
    await handle.sync();
  } catch {
    // 目录不可打开或不支持 fsync 时退化为无目录持久化保证。
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syncDirectoryBestEffortSync(dirPath: string): void {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // 同上。
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
