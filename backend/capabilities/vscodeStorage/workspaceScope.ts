import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  REGISTERED_STORAGE_ROOT_DIRS,
  SETTINGS_ROOT_DIR,
  WORKSPACE_RUNTIMES_ROOT_DIR
} from './constants';
import { isFileNotFoundError, readJsonStrict, writeJson } from './json';
import { withStorageResourceLock } from './storageResourceLock';
import { ensureStorageDirectory } from './storageFs';

const SCOPES_DIR = 'scopes';
const LEGACY_OWNER_FILE = 'legacy-owner.json';
const LEGACY_OWNER_KIND = 'limcode.workspaceRuntimeLegacyOwner';
const LEGACY_OWNER_SCHEMA_VERSION = 1;

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
  /** Only an actual saved workspace file or workspace folder set may claim legacy runtime data. */
  canClaimLegacy: boolean;
}

interface LegacyOwnerFile {
  kind: typeof LEGACY_OWNER_KIND;
  schemaVersion: typeof LEGACY_OWNER_SCHEMA_VERSION;
  scopeKey: string;
  claimedAt: string;
}

/** Pure, order-independent workspace identity calculation. Freeze its result once per Extension Host. */
export function createWorkspaceScopeIdentity(input: WorkspaceScopeIdentityInput): WorkspaceScopeIdentity {
  const savedWorkspaceFile = input.workspaceFileUri?.scheme !== 'untitled'
    ? input.workspaceFileUri
    : undefined;
  if (savedWorkspaceFile) {
    return scopeIdentity('workspaceFile', `workspace-file\n${canonicalUri(savedWorkspaceFile)}`, true);
  }

  const folders = [...new Set((input.workspaceFolderUris ?? []).map(canonicalUri))].sort();
  if (folders.length > 0) {
    return scopeIdentity('workspaceFolders', `workspace-folders\n${folders.join('\n')}`, true);
  }

  if (input.storageUri) {
    return scopeIdentity('storageUri', `storage-uri\n${canonicalUri(input.storageUri)}`, false);
  }
  return scopeIdentity('empty', 'empty-workspace', false);
}

export function workspaceScopedRuntimeRoot(configurationRootUri: vscode.Uri, scopeKey: string): vscode.Uri {
  return vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR, SCOPES_DIR, scopeKey);
}

/**
 * Resolve the frozen scope to either its isolated runtime tree or the legacy data root.
 * The first non-empty workspace that observes real legacy runtime data records ownership under
 * a cross-process lock. Empty windows and fresh installs never create an owner record.
 */
export async function resolveWorkspaceRuntimeRoot(
  configurationRootUri: vscode.Uri,
  scope: WorkspaceScopeIdentity
): Promise<vscode.Uri> {
  const scopedRoot = workspaceScopedRuntimeRoot(configurationRootUri, scope.scopeKey);
  const managementRoot = vscode.Uri.joinPath(configurationRootUri, WORKSPACE_RUNTIMES_ROOT_DIR);
  const ownerUri = vscode.Uri.joinPath(managementRoot, LEGACY_OWNER_FILE);

  await ensureStorageDirectory(managementRoot);
  return withStorageResourceLock(ownerUri, async () => {
    const ownerRead = await readJsonStrict<unknown>(ownerUri);
    if (ownerRead.status === 'ok') {
      const owner = parseLegacyOwner(ownerRead.value, ownerUri);
      return owner.scopeKey === scope.scopeKey ? configurationRootUri : scopedRoot;
    }
    if (ownerRead.status !== 'missing') {
      throw new Error(`Failed to read workspace runtime legacy owner: ${ownerUri.fsPath}: ${String(ownerRead.error)}`);
    }
    if (!scope.canClaimLegacy || !await hasLegacyRuntimeData(configurationRootUri)) return scopedRoot;

    const owner: LegacyOwnerFile = {
      kind: LEGACY_OWNER_KIND,
      schemaVersion: LEGACY_OWNER_SCHEMA_VERSION,
      scopeKey: scope.scopeKey,
      claimedAt: new Date().toISOString()
    };
    await writeJson(ownerUri, owner);
    return configurationRootUri;
  });
}

function scopeIdentity(source: WorkspaceScopeSource, canonicalIdentity: string, canClaimLegacy: boolean): WorkspaceScopeIdentity {
  return {
    scopeKey: createHash('sha256').update(canonicalIdentity).digest('hex'),
    source,
    canClaimLegacy
  };
}

function canonicalUri(uri: WorkspaceScopeUri): string {
  return uri.toString(true);
}

function parseLegacyOwner(value: unknown, uri: vscode.Uri): LegacyOwnerFile {
  if (!value || typeof value !== 'object') throw invalidLegacyOwner(uri);
  const candidate = value as Partial<LegacyOwnerFile>;
  if (
    candidate.kind !== LEGACY_OWNER_KIND
    || candidate.schemaVersion !== LEGACY_OWNER_SCHEMA_VERSION
    || typeof candidate.scopeKey !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.scopeKey)
    || typeof candidate.claimedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.claimedAt))
  ) {
    throw invalidLegacyOwner(uri);
  }
  return candidate as LegacyOwnerFile;
}

function invalidLegacyOwner(uri: vscode.Uri): Error {
  return new Error(`Invalid workspace runtime legacy owner: ${uri.fsPath}`);
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
