import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface ReadJsonOptions {
  throwOnError?: boolean;
}

let atomicWriteSequence = 0;

export async function readJson<T>(uri: vscode.Uri, options: ReadJsonOptions = {}): Promise<T | undefined> {
  let raw: Uint8Array;
  try {
    raw = uri.scheme === 'file'
      ? await fs.readFile(uri.fsPath)
      : await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    if (options.throwOnError) throw error;
    console.warn(`[LimCode] Failed to read JSON file: ${uri.fsPath}`, error);
    return undefined;
  }

  const text = Buffer.from(raw).toString('utf8').trim();
  if (!text) {
    const error = new Error(`JSON file is empty: ${uri.fsPath}`);
    if (options.throwOnError) throw error;
    console.warn(error.message);
    return undefined;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (options.throwOnError) throw error;
    console.warn(`[LimCode] Failed to parse JSON file: ${uri.fsPath}`, error);
    return undefined;
  }
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

function isFileNotFound(error: unknown): boolean {
  const candidate = error as FileSystemLikeError;
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  return code === 'ENOENT'
    || code === 'ENOTDIR'
    || code === 'FileNotFound'
    || code === 'EntryNotFound'
    || /^(FileNotFound|EntryNotFound)(?:\b|\s|\()/i.test(name);
}
