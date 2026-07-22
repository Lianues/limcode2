import * as fs from 'node:fs';
import * as path from 'node:path';

export type SyncJsonReadStatus = 'missing' | 'invalid' | 'ioError' | 'ok';

export type SyncJsonReadResult<T> =
  | { status: 'ok'; path: string; value: T }
  | { status: 'missing'; path: string; error: unknown }
  | { status: 'invalid'; path: string; error: unknown }
  | { status: 'ioError'; path: string; error: unknown };

let atomicWriteSequence = 0;

export function readJsonFileStrictSync<T = unknown>(filePath: string): SyncJsonReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return isFileNotFoundError(error)
      ? { status: 'missing', path: filePath, error }
      : { status: 'ioError', path: filePath, error };
  }

  const text = raw.trim();
  if (!text) return { status: 'invalid', path: filePath, error: new Error(`JSON file is empty: ${filePath}`) };

  try {
    return { status: 'ok', path: filePath, value: JSON.parse(text) as T };
  } catch (error) {
    return { status: 'invalid', path: filePath, error };
  }
}

export function writeJsonFileAtomicSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${atomicWriteSequence++}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameWithRetrySync(tempPath, filePath);
  } finally {
    rmWithRetrySync(tempPath, true);
  }
}

export function rmWithRetrySync(filePath: string, ignoreMissing = false): void {
  retryTransientFileOperationSync(() => {
    try {
      fs.rmSync(filePath, { force: false });
    } catch (error) {
      if (ignoreMissing && isFileNotFoundError(error)) return;
      throw error;
    }
  });
}

export function unlinkWithRetrySync(filePath: string, ignoreMissing = false): void {
  retryTransientFileOperationSync(() => {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (ignoreMissing && isFileNotFoundError(error)) return;
      throw error;
    }
  });
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

function renameWithRetrySync(source: string, target: string): void {
  retryTransientFileOperationSync(() => fs.renameSync(source, target));
}

export function isFileNotFoundError(error: unknown): boolean {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return code === 'ENOENT'
    || code === 'ENOTDIR'
    || code === 'FileNotFound'
    || code === 'EntryNotFound'
    || /^(FileNotFound|EntryNotFound)(?:\b|\s|\()/i.test(name)
    || /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|no such file|cannot find the path|找不到|不存在/i.test(message);
}

export function isTransientFileBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, Math.max(1, Math.floor(milliseconds)));
}
