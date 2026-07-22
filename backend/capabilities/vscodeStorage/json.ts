import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface ReadJsonOptions {
  throwOnError?: boolean;
}

export type StrictJsonReadStatus = 'missing' | 'invalid' | 'ioError' | 'ok';

export type StrictJsonReadResult<T> =
  | { status: 'ok'; uri: vscode.Uri; value: T }
  | { status: 'missing'; uri: vscode.Uri; error: unknown }
  | { status: 'invalid'; uri: vscode.Uri; error: unknown }
  | { status: 'ioError'; uri: vscode.Uri; error: unknown };

let atomicWriteSequence = 0;

/**
 * Strict JSON reader for storage code that must distinguish missing files,
 * malformed/empty JSON, and other I/O failures. Schema validation remains the
 * caller's responsibility.
 */
export async function readJsonStrict<T = unknown>(uri: vscode.Uri): Promise<StrictJsonReadResult<T>> {
  let raw: Uint8Array;
  try {
    raw = uri.scheme === 'file'
      ? await fs.readFile(uri.fsPath)
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
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (uri.scheme === 'file') {
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    const tempPath = `${uri.fsPath}.${process.pid}.${Date.now()}.${atomicWriteSequence++}.tmp`;
    try {
      await fs.writeFile(tempPath, data);
      await renameWithRetry(tempPath, uri.fsPath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
    return;
  }
  await vscode.workspace.fs.writeFile(uri, data);
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientRenameError(error)) throw error;
      await delay(10 * (2 ** (attempt - 1)));
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
