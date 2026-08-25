import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { WORKSPACE_RUNTIMES_ROOT_DIR } from './constants';
import { isFileNotFoundError } from './json';
import { ensureStorageDirectory, readStorageDirectory } from './storageFs';

export const WORKSPACE_SCOPES_DIR = 'scopes';
const WORKSPACE_SCOPE_KEY_PATTERN = /^[a-f0-9]{64}$/;

export interface WorkspaceScopeUri {
  readonly scheme?: string;
  readonly fsPath?: string;
  readonly path?: string;
  toString(skipEncoding?: boolean): string;
}

export interface WorkspaceScopeIdentityInput {
  workspaceFileUri?: WorkspaceScopeUri;
  workspaceFolderUris?: readonly WorkspaceScopeUri[];
  storageUri?: WorkspaceScopeUri;
}

export type WorkspaceScopeSource = 'workspaceFile' | 'workspaceFolders' | 'storageUri' | 'empty';

export interface WorkspaceScopeIdentity {
  /** SHA-256 only; filesystem paths and remote authority are never placed in directory names. */
  scopeKey: string;
  source: WorkspaceScopeSource;
}

/** Pure, order-independent workspace identity calculation. Freeze its result once per Extension Host. */
export function createWorkspaceScopeIdentity(input: WorkspaceScopeIdentityInput): WorkspaceScopeIdentity {
  const savedWorkspaceFile = input.workspaceFileUri?.scheme !== 'untitled'
    ? input.workspaceFileUri
    : undefined;
  const folders = [...new Set((input.workspaceFolderUris ?? []).map(canonicalUri))].sort();
  if (savedWorkspaceFile) {
    return scopeIdentity('workspaceFile', `workspace-file\n${canonicalUri(savedWorkspaceFile)}`);
  }
  if (folders.length > 0) {
    return scopeIdentity('workspaceFolders', `workspace-folders\n${folders.join('\n')}`);
  }
  if (input.storageUri) {
    return scopeIdentity('storageUri', `storage-uri\n${canonicalUri(input.storageUri)}`);
  }
  return scopeIdentity('empty', 'empty-workspace');
}

export function workspaceRuntimeScopesRoot(configurationRootUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR, WORKSPACE_SCOPES_DIR);
}

export function isWorkspaceScopeKey(value: string): boolean {
  return WORKSPACE_SCOPE_KEY_PATTERN.test(value);
}

export function workspaceScopedRuntimeRoot(configurationRootUri: vscode.Uri, scopeKey: string): vscode.Uri {
  if (!isWorkspaceScopeKey(scopeKey)) throw new Error(`Invalid workspace runtime scope key: ${scopeKey}`);
  return vscode.Uri.joinPath(workspaceRuntimeScopesRoot(configurationRootUri), scopeKey);
}

export async function listWorkspaceRuntimeScopes(configurationRootUri: vscode.Uri): Promise<Array<{ scopeKey: string; rootUri: vscode.Uri }>> {
  const scopesRoot = workspaceRuntimeScopesRoot(configurationRootUri);
  try {
    const entries = await readStorageDirectory(scopesRoot);
    return entries
      .filter(([name, type]) => isWorkspaceScopeKey(name) && (type & vscode.FileType.Directory) !== 0)
      .map(([scopeKey]) => ({ scopeKey, rootUri: workspaceScopedRuntimeRoot(configurationRootUri, scopeKey) }))
      .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

/** Resolve the frozen workspace identity directly to its isolated runtime root. */
export async function resolveWorkspaceRuntimeRoot(
  configurationRootUri: vscode.Uri,
  scope: WorkspaceScopeIdentity
): Promise<vscode.Uri> {
  await ensureStorageDirectory(vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR));
  return workspaceScopedRuntimeRoot(configurationRootUri, scope.scopeKey);
}

function scopeIdentity(source: WorkspaceScopeSource, canonicalIdentity: string): WorkspaceScopeIdentity {
  return {
    scopeKey: createHash('sha256').update(canonicalIdentity).digest('hex'),
    source
  };
}

function canonicalUri(uri: WorkspaceScopeUri): string {
  return uri.toString(true);
}
