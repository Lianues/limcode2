import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  REGISTERED_STORAGE_ROOT_DIRS,
  SETTINGS_ROOT_DIR,
  WORKSPACE_RUNTIMES_ROOT_DIR
} from './constants';
import { isFileNotFoundError } from './json';
import { withStorageResourceLock } from './storageResourceLock';
import { ensureStorageDirectory } from './storageFs';
import {
  LEGACY_PARTITION_ID,
  resolveLegacyPartition
} from './legacyPartition';

const SCOPES_DIR = 'scopes';
const LEGACY_PARTITION_MANIFEST_FILE = `${LEGACY_PARTITION_ID}.json`;

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
  /** Only an actual saved workspace file or workspace folder set may start/resume legacy partitioning. */
  canClaimLegacy: boolean;
  /** Frozen actual folder set used to lazily bind ownerUri to this real Workspace identity. */
  workspaceFolderUris: readonly string[];
}

/** Pure, order-independent workspace identity calculation. Freeze its result once per Extension Host. */
export function createWorkspaceScopeIdentity(input: WorkspaceScopeIdentityInput): WorkspaceScopeIdentity {
  const savedWorkspaceFile = input.workspaceFileUri?.scheme !== 'untitled'
    ? input.workspaceFileUri
    : undefined;
  const folders = [...new Set((input.workspaceFolderUris ?? []).map(canonicalUri))].sort();
  if (savedWorkspaceFile) {
    return scopeIdentity('workspaceFile', `workspace-file\n${canonicalUri(savedWorkspaceFile)}`, true, folders);
  }

  if (folders.length > 0) {
    return scopeIdentity('workspaceFolders', `workspace-folders\n${folders.join('\n')}`, true, folders);
  }

  if (input.storageUri) {
    return scopeIdentity('storageUri', `storage-uri\n${canonicalUri(input.storageUri)}`, false);
  }
  return scopeIdentity('empty', 'empty-workspace', false);
}

export function workspaceScopedRuntimeRoot(configurationRootUri: vscode.Uri, scopeKey: string): vscode.Uri {
  return vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR, SCOPES_DIR, scopeKey);
}

export function workspaceLegacyPartitionManifestUri(configurationRootUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR, LEGACY_PARTITION_MANIFEST_FILE);
}

/**
 * Resolve a frozen workspace scope. If pre-scope runtime data exists, the first non-empty Workspace
 * records the immutable firstWorkspaceScopeKey and partitions every non-empty Conversation exactly
 * once. Empty windows never start the migration. The legacy root remains an untouched rollback
 * archive after the atomic manifest commit.
 */
export async function resolveWorkspaceRuntimeRoot(
  configurationRootUri: vscode.Uri,
  scope: WorkspaceScopeIdentity
): Promise<vscode.Uri> {
  const scopedRoot = workspaceScopedRuntimeRoot(configurationRootUri, scope.scopeKey);
  const managementRoot = vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR);
  const manifestUri = workspaceLegacyPartitionManifestUri(configurationRootUri);

  await ensureStorageDirectory(managementRoot);
  return withStorageResourceLock(manifestUri, () => resolveLegacyPartition({
    configurationRootUri,
    managementRootUri: managementRoot,
    manifestUri,
    scopedRootUri: scopedRoot
  }, scope, () => hasLegacyRuntimeData(configurationRootUri)));
}

function scopeIdentity(
  source: WorkspaceScopeSource,
  canonicalIdentity: string,
  canClaimLegacy: boolean,
  workspaceFolderUris: readonly string[] = []
): WorkspaceScopeIdentity {
  return {
    scopeKey: createHash('sha256').update(canonicalIdentity).digest('hex'),
    source,
    canClaimLegacy,
    workspaceFolderUris
  };
}

function canonicalUri(uri: WorkspaceScopeUri): string {
  return uri.toString(true);
}

async function hasLegacyRuntimeData(configurationRootUri: vscode.Uri): Promise<boolean> {
  if (await hasLegacyConversationSettings(configurationRootUri)) return true;
  for (const name of REGISTERED_STORAGE_ROOT_DIRS) {
    if (name === SETTINGS_ROOT_DIR || name === WORKSPACE_RUNTIMES_ROOT_DIR) continue;
    const root = vscode.Uri.joinPath(configurationRootUri, name);
    try {
      if ((await vscode.workspace.fs.readDirectory(root)).length > 0) return true;
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  }
  return false;
}

async function hasLegacyConversationSettings(configurationRootUri: vscode.Uri): Promise<boolean> {
  const settingsRoot = vscode.Uri.joinPath(configurationRootUri, SETTINGS_ROOT_DIR);
  try {
    const entries = await vscode.workspace.fs.readDirectory(settingsRoot);
    return entries.some(([name, type]) =>
      (type & vscode.FileType.File) !== 0
      && /^conversation-.+-(?:llm|common)\.json$/i.test(name)
    );
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}
