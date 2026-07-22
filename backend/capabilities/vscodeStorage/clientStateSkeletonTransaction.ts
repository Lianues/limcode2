import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { STORAGE_VERSION } from './constants';
import type { StoragePaths } from './clientStateStore';
import { readJsonStrict, writeJson } from './json';
import { withStorageResourceLock } from './storageResourceLock';

const CLIENT_STATE_SKELETON_MANIFEST_FILE = '.client-state-skeleton-manifest.json';
const CLIENT_STATE_SKELETON_TRANSACTION_RESOURCE = '.client-state-skeleton-transaction';
const CLIENT_STATE_SKELETON_MANIFEST_KIND = 'clientStateSkeleton.manifest';
const EMPTY_SKELETON_TRANSACTION_ID = 'empty';

type ClientStateSkeletonManifestState = 'writing' | 'committed';

interface ClientStateSkeletonManifest {
  kind: typeof CLIENT_STATE_SKELETON_MANIFEST_KIND;
  schemaVersion: typeof STORAGE_VERSION;
  state: ClientStateSkeletonManifestState;
  transactionId: string;
  startedAt: string;
  committedAt?: string;
}

export interface ClientStateSkeletonReadContext {
  transactionId: string;
}

export interface ClientStateSkeletonMutationResult<T> {
  value: T;
  commit: boolean;
}

export interface ClientStateSkeletonTransactionTestHooks {
  afterManifestWrite?: (manifest: Readonly<ClientStateSkeletonManifest>) => void | Promise<void>;
}

export const __clientStateSkeletonTransactionTestHooks: ClientStateSkeletonTransactionTestHooks = {};

/**
 * Read a coherent client-state skeleton snapshot. Readers and every skeleton
 * mutation share one resource lock, so no reader can observe a subset of the
 * independently stored ECS tables.
 */
export async function withClientStateSkeletonReadTransaction<T>(
  paths: StoragePaths,
  action: (context: ClientStateSkeletonReadContext) => Promise<T>,
  expectedTransactionId?: string
): Promise<T> {
  return withStorageResourceLock(clientStateSkeletonTransactionResourceUri(paths), async () => {
    const manifest = await readCommittedClientStateSkeletonManifest(paths);
    const transactionId = manifest?.transactionId ?? EMPTY_SKELETON_TRANSACTION_ID;
    if (expectedTransactionId !== undefined && transactionId !== expectedTransactionId) {
      throw new Error(`Client-state skeleton snapshot changed during staged hydration: expected=${expectedTransactionId}, actual=${transactionId}`);
    }
    return action({ transactionId });
  });
}

/**
 * Mutate one or more skeleton record stores as one published snapshot. The
 * writing marker is deliberately left in place after a failure/partial result,
 * preventing future readers from treating mixed tables as a valid snapshot.
 * A later complete mutation may repair and publish the stores again.
 */
export async function withClientStateSkeletonMutation<T>(
  paths: StoragePaths,
  action: () => Promise<ClientStateSkeletonMutationResult<T>>
): Promise<T> {
  return withStorageResourceLock(clientStateSkeletonTransactionResourceUri(paths), async () => {
    const transactionId = randomUUID();
    const startedAt = new Date().toISOString();
    await writeClientStateSkeletonManifest(paths, {
      state: 'writing',
      transactionId,
      startedAt
    });

    const result = await action();
    if (result.commit) {
      await writeClientStateSkeletonManifest(paths, {
        state: 'committed',
        transactionId,
        startedAt,
        committedAt: new Date().toISOString()
      });
    }
    return result.value;
  });
}

async function readCommittedClientStateSkeletonManifest(paths: StoragePaths): Promise<ClientStateSkeletonManifest | undefined> {
  const uri = clientStateSkeletonManifestUri(paths);
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') {
    const traces = await findClientStateSkeletonTraces(paths);
    if (traces.length === 0) return undefined;
    throw new Error(`Client-state skeleton manifest is missing while record-store traces exist: ${traces.join(', ')}`);
  }
  if (result.status === 'invalid') throw new Error(`Client-state skeleton manifest JSON is invalid: ${uri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read client-state skeleton manifest: ${uri.fsPath}`);

  const manifest = parseClientStateSkeletonManifest(result.value, uri);
  if (manifest.state !== 'committed') {
    // 写入者先落 `writing` 标记、再写全部存储、最后落 `committed`。若进程在最后一步前退出，
    // 清单会停在 `writing`。由于存储本身是原子写且此刻持锁无并发写者，现有存储即为一份完整快照，
    // 把该事务提升为 committed 即可从被中断的写入中恢复。
    return promoteWritingSkeletonManifestToCommitted(paths, manifest);
  }
  return manifest;
}

async function promoteWritingSkeletonManifestToCommitted(paths: StoragePaths, manifest: ClientStateSkeletonManifest): Promise<ClientStateSkeletonManifest> {
  const committedAt = new Date().toISOString();
  await writeClientStateSkeletonManifest(paths, { state: 'committed', transactionId: manifest.transactionId, startedAt: manifest.startedAt, committedAt });
  console.warn(`[LimCode] Recovered an interrupted client-state skeleton write by committing transaction ${manifest.transactionId}.`);
  return { ...manifest, state: 'committed', committedAt };
}

function parseClientStateSkeletonManifest(value: unknown, uri: vscode.Uri): ClientStateSkeletonManifest {
  const manifest = value as Partial<ClientStateSkeletonManifest> | undefined;
  if (!manifest
    || manifest.kind !== CLIENT_STATE_SKELETON_MANIFEST_KIND
    || manifest.schemaVersion !== STORAGE_VERSION
    || (manifest.state !== 'writing' && manifest.state !== 'committed')
    || typeof manifest.transactionId !== 'string'
    || !manifest.transactionId.trim()
    || typeof manifest.startedAt !== 'string'
    || !manifest.startedAt.trim()
    || (manifest.committedAt !== undefined && (typeof manifest.committedAt !== 'string' || !manifest.committedAt.trim()))
    || (manifest.state === 'committed' && !manifest.committedAt)) {
    throw new Error(`Client-state skeleton manifest structure is invalid: ${uri.fsPath}`);
  }
  return {
    kind: CLIENT_STATE_SKELETON_MANIFEST_KIND,
    schemaVersion: STORAGE_VERSION,
    state: manifest.state,
    transactionId: manifest.transactionId,
    startedAt: manifest.startedAt,
    ...(manifest.committedAt ? { committedAt: manifest.committedAt } : {})
  };
}

async function writeClientStateSkeletonManifest(
  paths: StoragePaths,
  input: {
    state: ClientStateSkeletonManifestState;
    transactionId: string;
    startedAt: string;
    committedAt?: string;
  }
): Promise<void> {
  const manifest: ClientStateSkeletonManifest = {
    kind: CLIENT_STATE_SKELETON_MANIFEST_KIND,
    schemaVersion: STORAGE_VERSION,
    state: input.state,
    transactionId: input.transactionId,
    startedAt: input.startedAt,
    ...(input.committedAt ? { committedAt: input.committedAt } : {})
  };
  await writeJson(clientStateSkeletonManifestUri(paths), manifest);
  await __clientStateSkeletonTransactionTestHooks.afterManifestWrite?.(manifest);
}

async function findClientStateSkeletonTraces(paths: StoragePaths): Promise<string[]> {
  const traces: string[] = [];
  for (const uri of clientStateSkeletonIndexUris(paths)) {
    const result = await readJsonStrict<unknown>(uri);
    if (result.status === 'missing') continue;
    if (result.status === 'ioError') throw new Error(`Failed to inspect client-state skeleton trace: ${uri.fsPath}`);
    traces.push(relativeStoragePath(paths.globalStorageUri, uri));
  }
  return traces;
}

function clientStateSkeletonIndexUris(paths: StoragePaths): vscode.Uri[] {
  return [
    paths.agentsIndexUri,
    paths.workflowsIndexUri,
    paths.planReviewPoliciesIndexUri,
    paths.planReviewPolicyScopeLinksIndexUri,
    paths.toolPoliciesIndexUri,
    paths.toolPolicyScopeLinksIndexUri,
    paths.skillPoliciesIndexUri,
    paths.skillPolicyScopeLinksIndexUri,
    paths.systemPromptsIndexUri,
    paths.systemPromptScopeLinksIndexUri,
    paths.runtimeContextsIndexUri,
    paths.runtimeContextScopeLinksIndexUri,
    paths.runtimeContextSnapshotsIndexUri,
    paths.conversationRuntimeContextSnapshotLinksIndexUri,
    paths.runRuntimeContextSnapshotLinksIndexUri,
    paths.modelProfilesIndexUri,
    paths.modelProfileScopeLinksIndexUri,
    paths.conversationWorkflowSelectionsIndexUri,
    paths.conversationsIndexUri,
    vscode.Uri.joinPath(paths.conversationsRootUri, 'reuse-links', 'index.json'),
    vscode.Uri.joinPath(paths.conversationsRootUri, 'branch-links', 'index.json'),
    vscode.Uri.joinPath(paths.conversationsRootUri, 'origin-links', 'index.json'),
    paths.linksIndexUri,
    paths.conversationAgentSelectionsIndexUri,
    paths.agentAnswersIndexUri,
    paths.agentAnswerSubmissionLinksIndexUri,
    paths.agentAnswerTargetLinksIndexUri,
    paths.projectContextsIndexUri,
    paths.conversationProjectLinksIndexUri,
    paths.workEnvironmentsIndexUri,
    paths.workEnvironmentPoliciesIndexUri,
    paths.workEnvironmentPolicyScopeLinksIndexUri,
    paths.conversationWorkEnvironmentLinksIndexUri,
    paths.runWorkEnvironmentLinksIndexUri,
    paths.checkpointPoliciesIndexUri,
    paths.checkpointPolicyScopeLinksIndexUri,
    paths.shadowRepositoriesIndexUri,
    paths.conversationCheckpointRepositoryLinksIndexUri,
    paths.checkpointsIndexUri,
    paths.checkpointTimelineAnchorsIndexUri
  ];
}

function clientStateSkeletonManifestUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.globalStorageUri, CLIENT_STATE_SKELETON_MANIFEST_FILE);
}

function clientStateSkeletonTransactionResourceUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.globalStorageUri, CLIENT_STATE_SKELETON_TRANSACTION_RESOURCE);
}

function relativeStoragePath(root: vscode.Uri, target: vscode.Uri): string {
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const targetPath = target.fsPath.replace(/\\/g, '/');
  return targetPath.startsWith(`${rootPath}/`) ? targetPath.slice(rootPath.length + 1) : targetPath;
}
