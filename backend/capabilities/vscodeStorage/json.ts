import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export async function readJson<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const raw = uri.scheme === 'file'
      ? await fs.readFile(uri.fsPath)
      : await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString('utf8').trim();
    return text ? JSON.parse(text) as T : undefined;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    console.warn(`[LimCode] Failed to read JSON file: ${uri.fsPath}`, error);
    return undefined;
  }
}

export async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (uri.scheme === 'file') {
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.writeFile(uri.fsPath, data);
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

function isFileNotFound(error: unknown): boolean {
  const candidate = error as FileSystemLikeError;
  const text = [
    candidate.name,
    candidate.code,
    candidate.message,
    candidate.stack,
    String(error)
  ].filter((part): part is string => typeof part === 'string').join('\n');

  return /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|not found|no such file|不存在|无法解析不存在的文件/i.test(text);
}
