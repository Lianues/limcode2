import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { WORKSPACE_RUNTIMES_ROOT_DIR } from './constants';
import { ensureStorageDirectory } from './storageFs';

const SCOPES_DIR = 'scopes';

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

export function workspaceScopedRuntimeRoot(configurationRootUri: vscode.Uri, scopeKey: string): vscode.Uri {
  return vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR, SCOPES_DIR, scopeKey);
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
