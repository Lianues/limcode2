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

const TRANSIENT_FILE_OPERATION_MAX_ATTEMPTS = 4;
const TRANSIENT_FILE_OPERATION_BASE_DELAY_MS = 10;

export function isTransientFileBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function createAtomicTempPath(fsPath: string): string {
  return `${fsPath}.${process.pid}.${Date.now()}.${atomicWriteSequence++}.tmp`;
}

/** 不强制刷盘的原子写，适用于 heartbeat、lease 与可再生缓存。 */
export async function writeFileAtomic(fsPath: string, data: Uint8Array | string): Promise<void> {
  await fsp.mkdir(path.dirname(fsPath), { recursive: true });
  const tempPath = createAtomicTempPath(fsPath);
  try {
    await fsp.writeFile(tempPath, data);
    await renameWithRetry(tempPath, fsPath);
  } finally {
    await removeAtomicTempBestEffort(tempPath);
  }
}

/** writeFileAtomic 的同步版本；不执行 fsync，避免高频 heartbeat 阻塞 Extension Host。 */
export function writeFileAtomicSync(fsPath: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(fsPath), { recursive: true });
  const tempPath = createAtomicTempPath(fsPath);
  try {
    fs.writeFileSync(tempPath, data);
    renameWithRetrySync(tempPath, fsPath);
  } finally {
    removeAtomicTempBestEffortSync(tempPath);
  }
}

/**
 * 原子发布一次持久化写入，数据在 rename 前已 fsync 落盘。
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
    await removeAtomicTempBestEffort(tempPath);
  }
  await syncDirectoryAfterRename(path.dirname(fsPath));
}

/** writeFileAtomicDurable 的同步版本，供 shutdown 路径等无法 await 的场景使用。 */
export function writeFileAtomicDurableSync(fsPath: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(fsPath), { recursive: true });
  const tempPath = createAtomicTempPath(fsPath);
  try {
    writeFileDurableSync(tempPath, data);
    renameWithRetrySync(tempPath, fsPath);
  } finally {
    removeAtomicTempBestEffortSync(tempPath);
  }
  syncDirectoryAfterRenameSync(path.dirname(fsPath));
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
  let handle: fsp.FileHandle;
  try {
    handle = await openFileHandleWithRetry(fsPath, 'r+');
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(fsPath, error);
    return;
  }
  try {
    await syncFileHandle(handle, fsPath);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function writeFileDurableSync(fsPath: string, data: Uint8Array | string): void {
  fs.writeFileSync(fsPath, data);
  let fd: number;
  try {
    fd = retryTransientFileOperationSync(() => fs.openSync(fsPath, 'r+'));
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(fsPath, error);
    return;
  }
  try {
    syncFileDescriptor(fd, fsPath);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不应掩盖写入阶段的错误。
    }
  }
}

/**
 * 只有文件系统明确不实现 fsync 时才允许退化为原来的 OS 回写语义。
 * EIO 等真实磁盘错误必须原样抛出，使原子写在 rename 前终止并保留旧目标文件。
 */
async function syncFileHandle(handle: fsp.FileHandle, fsPath?: string): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(fsPath, error);
  }
}

function syncFileDescriptor(fd: number, fsPath?: string): void {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(fsPath, error);
  }
}

let fsyncUnsupportedWarned = false;

/** 挂载点根本不实现 fsync 时可能返回的错误码。 */
const FSYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'ENOTTY', 'EPERM']);

function isFsyncUnsupportedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && FSYNC_UNSUPPORTED_CODES.has(code);
}

function warnFsyncUnsupported(fsPath: string | undefined, error: unknown): void {
  if (fsyncUnsupportedWarned) return;
  fsyncUnsupportedWarned = true;
  console.warn(
    `[LimCode] fsync is unsupported for storage write${fsPath ? ` (${fsPath})` : ''}; `
      + 'data durability falls back to OS flushing and may be lost on power failure.',
    error
  );
}

export async function renameWithRetry(source: string, target: string): Promise<void> {
  return retryTransientFileOperation(() => fsp.rename(source, target));
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
 * 目录 fsync 能把 rename 产生的目录项变更落盘。Windows 对目录句柄调用 fsync 会返回
 * EPERM，因此按平台门控跳过；POSIX 下只有明确“不支持 fsync”的错误允许降级，EIO 等
 * 真实故障会向上传递，避免上层在提交不确定时继续清理旧 generation。
 */
const DIRECTORY_FSYNC_SUPPORTED = process.platform !== 'win32';

async function syncDirectoryAfterRename(dirPath: string): Promise<void> {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await openFileHandleWithRetry(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(dirPath, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syncDirectoryAfterRenameSync(dirPath: string): void {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;
  let fd: number | undefined;
  try {
    fd = retryTransientFileOperationSync(() => fs.openSync(dirPath, 'r'));
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(dirPath, error);
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

async function openFileHandleWithRetry(fsPath: string, flags: string): Promise<fsp.FileHandle> {
  return retryTransientFileOperation(() => fsp.open(fsPath, flags));
}

async function retryTransientFileOperation<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= TRANSIENT_FILE_OPERATION_MAX_ATTEMPTS || !isTransientFileBusyError(error)) throw error;
      await delay(TRANSIENT_FILE_OPERATION_BASE_DELAY_MS * (2 ** (attempt - 1)));
    }
  }
}

async function removeAtomicTempBestEffort(tempPath: string): Promise<void> {
  await retryTransientFileOperation(() => fsp.rm(tempPath, { force: true })).catch(() => undefined);
}

function removeAtomicTempBestEffortSync(tempPath: string): void {
  try {
    retryTransientFileOperationSync(() => fs.rmSync(tempPath, { force: true }));
  } catch {
    // 清理失败不应掩盖写入阶段的原始错误。
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
