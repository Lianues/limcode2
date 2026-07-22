import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isFileNotFoundError } from './json';

export const STORAGE_GENERATIONS_DIR = 'generations';

export interface StorageGenerationOptions {
  generationsDir?: string;
}

export interface StorageGenerationLocation {
  id: string;
  relativePath: string;
  rootUri: vscode.Uri;
}

export interface StorageGenerationCleanupFailure {
  generation: StorageGenerationLocation;
  error: unknown;
}

export interface StorageGenerationCleanupResult {
  deleted: StorageGenerationLocation[];
  failed: StorageGenerationCleanupFailure[];
}

const STORAGE_GENERATION_ID_PATTERN = /^\d{8}-\d{6}-\d{3}-[a-f0-9]{8}$/;
const STORAGE_GENERATION_CONTAINER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function createStorageGenerationId(date: Date = new Date()): string {
  const timestamp = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    '-',
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
    '-',
    date.getUTCMilliseconds().toString().padStart(3, '0')
  ].join('');
  return `${timestamp}-${randomBytes(4).toString('hex')}`;
}

export function isSafeStorageGenerationId(id: string): boolean {
  return STORAGE_GENERATION_ID_PATTERN.test(id);
}

export function assertSafeStorageGenerationId(id: string): string {
  if (!isSafeStorageGenerationId(id)) throw new Error(`Invalid storage generation id: ${id}`);
  return id;
}

export function getStorageGenerationsRootUri(baseRootUri: vscode.Uri, options: StorageGenerationOptions = {}): vscode.Uri {
  return vscode.Uri.joinPath(baseRootUri, normalizeGenerationsDir(options.generationsDir));
}

export function getStorageGenerationRelativePath(id: string, options: StorageGenerationOptions = {}): string {
  return `${normalizeGenerationsDir(options.generationsDir)}/${assertSafeStorageGenerationId(id)}`;
}

export function getStorageGenerationRootUri(baseRootUri: vscode.Uri, id: string, options: StorageGenerationOptions = {}): vscode.Uri {
  return vscode.Uri.joinPath(baseRootUri, ...getStorageGenerationRelativePath(id, options).split('/'));
}

export function createStorageGenerationLocation(baseRootUri: vscode.Uri, id: string = createStorageGenerationId(), options: StorageGenerationOptions = {}): StorageGenerationLocation {
  return {
    id: assertSafeStorageGenerationId(id),
    relativePath: getStorageGenerationRelativePath(id, options),
    rootUri: getStorageGenerationRootUri(baseRootUri, id, options)
  };
}

export async function listStorageGenerations(baseRootUri: vscode.Uri, options: StorageGenerationOptions = {}): Promise<StorageGenerationLocation[]> {
  const generationsRootUri = getStorageGenerationsRootUri(baseRootUri, options);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(generationsRootUri);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }

  return entries
    .filter(([id, type]) => type === vscode.FileType.Directory && isSafeStorageGenerationId(id))
    .map(([id]) => createStorageGenerationLocation(baseRootUri, id, options))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function cleanupInactiveStorageGenerations(
  baseRootUri: vscode.Uri,
  activeGenerationIds: Iterable<string>,
  options: StorageGenerationOptions = {}
): Promise<StorageGenerationCleanupResult> {
  const active = new Set<string>();
  for (const id of activeGenerationIds) active.add(assertSafeStorageGenerationId(id));

  const deleted: StorageGenerationLocation[] = [];
  const failed: StorageGenerationCleanupFailure[] = [];
  const generations = await listStorageGenerations(baseRootUri, options);
  for (const generation of generations) {
    if (active.has(generation.id)) continue;
    try {
      await vscode.workspace.fs.delete(generation.rootUri, { recursive: true, useTrash: false });
      deleted.push(generation);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        deleted.push(generation);
        continue;
      }
      failed.push({ generation, error });
    }
  }
  return { deleted, failed };
}

function normalizeGenerationsDir(value: string | undefined): string {
  const candidate = value?.trim() || STORAGE_GENERATIONS_DIR;
  if (!STORAGE_GENERATION_CONTAINER_PATTERN.test(candidate) || candidate === '.' || candidate === '..') {
    throw new Error(`Invalid storage generations directory: ${value}`);
  }
  return candidate;
}
