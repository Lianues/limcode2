import * as fs from 'node:fs';
import { isTransientFileBusyError, retryTransientFileOperationSync, sleepSync, writeFileAtomicDurableSync } from './durableWrite';

export { isTransientFileBusyError, retryTransientFileOperationSync, sleepSync };

export type SyncJsonReadStatus = 'missing' | 'invalid' | 'ioError' | 'ok';

export type SyncJsonReadResult<T> =
  | { status: 'ok'; path: string; value: T }
  | { status: 'missing'; path: string; error: unknown }
  | { status: 'invalid'; path: string; error: unknown }
  | { status: 'ioError'; path: string; error: unknown };

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
  writeFileAtomicDurableSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

