import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { writeFileAtomic, writeFileAtomicDurable } from './durableWrite';
import { isNodeFsStorageUri, nodeFsStoragePath } from './localStorageUri';

export interface ReadJsonOptions {
  throwOnError?: boolean;
}

export type StrictJsonReadStatus = 'missing' | 'invalid' | 'ioError' | 'ok';

export type StrictJsonReadResult<T> =
  | { status: 'ok'; uri: vscode.Uri; value: T }
  | { status: 'missing'; uri: vscode.Uri; error: unknown }
  | { status: 'invalid'; uri: vscode.Uri; error: unknown }
  | { status: 'ioError'; uri: vscode.Uri; error: unknown };

/**
 * Strict JSON reader for storage code that must distinguish missing files,
 * malformed/empty JSON, and other I/O failures. Schema validation remains the
 * caller's responsibility.
 */
export async function readJsonStrict<T = unknown>(uri: vscode.Uri): Promise<StrictJsonReadResult<T>> {
  let raw: Uint8Array;
  try {
    raw = isNodeFsStorageUri(uri)
      ? await fs.readFile(nodeFsStoragePath(uri))
      : await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    return isFileNotFoundError(error)
      ? { status: 'missing', uri, error }
      : { status: 'ioError', uri, error };
  }

  const text = Buffer.from(raw).toString('utf8').trim();
  if (!text) {
    return { status: 'invalid', uri, error: new Error(`JSON file is empty: ${uri.fsPath}`) };
  }

  try {
    return { status: 'ok', uri, value: JSON.parse(text) as T };
  } catch (error) {
    return { status: 'invalid', uri, error };
  }
}

export async function readJson<T>(uri: vscode.Uri, options: ReadJsonOptions = {}): Promise<T | undefined> {
  const result = await readJsonStrict<T>(uri);
  if (result.status === 'ok') return result.value;
  if (result.status === 'missing') return undefined;

  if (options.throwOnError) throw result.error;
  if (result.status === 'invalid') {
    console.warn(`[LimCode] Failed to parse JSON file: ${uri.fsPath}`, result.error);
  } else {
    console.warn(`[LimCode] Failed to read JSON file: ${uri.fsPath}`, result.error);
  }
  return undefined;
}

export async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  return writeJsonWith(uri, value, writeFileAtomicDurable);
}

/** heartbeat、lease 等可再生协调数据只要求原子替换，不强制刷盘。 */
export async function writeJsonAtomic(uri: vscode.Uri, value: unknown): Promise<void> {
  return writeJsonWith(uri, value, writeFileAtomic);
}

async function writeJsonWith(
  uri: vscode.Uri,
  value: unknown,
  writeLocalFile: (fsPath: string, data: Uint8Array) => Promise<void>
): Promise<void> {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (isNodeFsStorageUri(uri)) {
    await writeLocalFile(nodeFsStoragePath(uri), data);
    return;
  }
  await vscode.workspace.fs.writeFile(uri, data);
}

interface FileSystemLikeError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
}

export function isFileNotFoundError(error: unknown): boolean {
  const candidate = error as FileSystemLikeError;
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
