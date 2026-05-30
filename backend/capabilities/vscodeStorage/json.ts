import * as vscode from 'vscode';

export async function readJson<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString('utf8').trim();
    return text ? JSON.parse(text) as T : undefined;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    console.warn(`[LimCode] Failed to read JSON file: ${uri.fsPath}`, error);
    return undefined;
  }
}

export async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function isFileNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /FileNotFound|ENOENT|not found/i.test(error.message);
}
