import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  CheckpointPolicyRecord,
  CheckpointTriggerConfigRecord
} from '../../../../shared/protocol';
import { STORAGE_VERSION } from '../../../capabilities/vscodeStorage/constants';

export const DEFAULT_CHECKPOINT_MAX_BYTES = 50 * 1024 * 1024;

export const DEFAULT_CHECKPOINT_TRIGGERS: CheckpointTriggerConfigRecord = {
  conversationInitial: true,
  userMessageBefore: true,
  userMessageAfter: false,
  llmResponseBefore: false,
  llmResponseAfter: false,
  toolExecutionBefore: true,
  toolExecutionAfter: true,
  agentRunCompletedBefore: false,
  agentRunCompletedAfter: true,
  manual: true
};

export interface EmptyDirectoryManifest {
  schemaVersion: typeof STORAGE_VERSION;
  emptyDirectories: string[];
}

export function normalizeCheckpointPolicy(input: Partial<CheckpointPolicyRecord> & { id: string; name: string }): CheckpointPolicyRecord {
  const now = Date.now();
  return {
    id: input.id,
    name: input.name.trim() || '存档点策略',
    enabled: input.enabled ?? true,
    initialSnapshotMaxBytes: normalizeByteLimit(input.initialSnapshotMaxBytes),
    preserveEmptyDirectories: input.preserveEmptyDirectories ?? true,
    useGitignore: input.useGitignore ?? true,
    skipPatterns: uniquePatterns(input.skipPatterns),
    triggers: { ...DEFAULT_CHECKPOINT_TRIGGERS, ...(input.triggers ?? {}) },
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

export function workspaceContainsProject(workspaceFolderUris: readonly string[], projectUri: string): boolean {
  const projectPath = fsPathFromUri(projectUri);
  if (!projectPath) return false;
  const normalizedProject = normalizeFsPath(projectPath);
  return workspaceFolderUris.some((uri) => {
    const workspacePath = fsPathFromUri(uri);
    if (!workspacePath) return false;
    const normalizedWorkspace = normalizeFsPath(workspacePath);
    return normalizedProject === normalizedWorkspace || normalizedProject.startsWith(normalizedWorkspace + path.sep);
  });
}

export function emptyDirectoryManifest(paths: readonly string[]): EmptyDirectoryManifest {
  return {
    schemaVersion: STORAGE_VERSION,
    emptyDirectories: [...new Set(paths.map(normalizeRelativePath).filter(Boolean))].sort()
  };
}

export function triggerConfigKey(trigger: string): keyof CheckpointTriggerConfigRecord | undefined {
  switch (trigger) {
    case 'conversation_initial': return 'conversationInitial';
    case 'user_message_before': return 'userMessageBefore';
    case 'user_message_after': return 'userMessageAfter';
    case 'llm_response_before': return 'llmResponseBefore';
    case 'llm_response_after': return 'llmResponseAfter';
    case 'tool_execution_before': return 'toolExecutionBefore';
    case 'tool_execution_after': return 'toolExecutionAfter';
    case 'agent_run_completed_before': return 'agentRunCompletedBefore';
    case 'agent_run_completed_after': return 'agentRunCompletedAfter';
    case 'manual': return 'manual';
    default: return undefined;
  }
}

export function safeStorageKey(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'shadow-repo';
}

function normalizeByteLimit(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : DEFAULT_CHECKPOINT_MAX_BYTES;
}

function uniquePatterns(patterns: readonly string[] | undefined): string[] {
  const result: string[] = [];
  for (const raw of patterns ?? []) {
    const pattern = raw.replace(/\r?\n/g, '');
    if (!pattern.trim() || result.includes(pattern)) continue;
    result.push(pattern);
  }
  return result;
}

function fsPathFromUri(uri: string): string | undefined {
  try {
    if (uri.startsWith('file:')) return fileURLToPath(uri);
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
