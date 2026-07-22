import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { STORAGE_VERSION } from './constants';
import { sameFsPath } from './globalStatus';
import { isFileNotFoundError, readJsonStrict, writeJson } from './json';

const DATA_ROOT_LEASES_DIR = '.limcode-data-root-leases';
const DATA_ROOT_MIGRATION_LOCK_FILE = '.limcode-data-root-migration';
const DATA_ROOT_PROCESS_LEASE_KIND = 'dataRoot.processLease';
export const DATA_ROOT_MIGRATION_OPERATION = 'dataRootMigration';

const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_STALE_MS = 45_000;

export interface DataRootProcessLeaseOperation {
  kind: string;
  startedAt: number;
  targetRootPath?: string;
}

export interface DataRootProcessLeaseRecord {
  kind: typeof DATA_ROOT_PROCESS_LEASE_KIND;
  schemaVersion: typeof STORAGE_VERSION;
  instanceId: string;
  pid: number;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  activeRootPath: string;
  activeOperation?: DataRootProcessLeaseOperation;
}

interface ListedDataRootProcessLease {
  uri: vscode.Uri;
  record: DataRootProcessLeaseRecord;
}

export interface DataRootProcessLeaseTestOptions {
  heartbeatIntervalMs?: number;
  staleMs?: number;
}

export const __dataRootProcessLeaseTestOptions: DataRootProcessLeaseTestOptions = {};

export class DataRootProcessLease {
  public readonly instanceId = randomUUID();
  private readonly createdAt = Date.now();
  private activeOperation: DataRootProcessLeaseOperation | undefined;
  private timer: NodeJS.Timeout | undefined;
  private writeInFlight: Promise<void> | undefined;
  private disposed = false;
  private lastError: unknown;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly activeRootPath: () => string
  ) {}

  public get lastHeartbeatError(): unknown { return this.lastError; }

  public start(): void {
    if (this.timer || this.disposed) return;
    this.scheduleHeartbeat();
    this.timer = setInterval(() => this.scheduleHeartbeat(), leaseHeartbeatIntervalMs());
    this.timer.unref?.();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    void deleteLeaseUri(leaseUri(this.context, this.instanceId));
  }

  public async heartbeat(): Promise<void> {
    if (this.disposed) return;
    if (this.writeInFlight) await this.writeInFlight;
    await this.writeLease();
  }

  public async setActiveOperation(operation: Omit<DataRootProcessLeaseOperation, 'startedAt'> & { startedAt?: number }): Promise<void> {
    this.activeOperation = {
      ...operation,
      startedAt: operation.startedAt ?? Date.now()
    };
    await this.heartbeat();
  }

  public async clearActiveOperation(kind?: string): Promise<void> {
    if (!kind || this.activeOperation?.kind === kind) this.activeOperation = undefined;
    await this.heartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.disposed || this.writeInFlight) return;
    this.writeInFlight = this.writeLease()
      .catch((error) => {
        this.lastError = error;
        console.warn('[LimCode] Failed to refresh data-root process lease:', error);
      })
      .finally(() => { this.writeInFlight = undefined; });
  }

  private async writeLease(): Promise<void> {
    const now = Date.now();
    const record: DataRootProcessLeaseRecord = {
      kind: DATA_ROOT_PROCESS_LEASE_KIND,
      schemaVersion: STORAGE_VERSION,
      instanceId: this.instanceId,
      pid: process.pid,
      createdAt: this.createdAt,
      updatedAt: now,
      heartbeatAt: now,
      activeRootPath: this.activeRootPath(),
      ...(this.activeOperation ? { activeOperation: this.activeOperation } : {})
    };
    await writeJson(leaseUri(this.context, this.instanceId), record);
    this.lastError = undefined;
  }
}

export function dataRootMigrationLockUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, DATA_ROOT_MIGRATION_LOCK_FILE);
}

export function createDataRootProcessLease(context: vscode.ExtensionContext, activeRootPath: () => string): DataRootProcessLease {
  return new DataRootProcessLease(context, activeRootPath);
}

export async function assertNoOtherLiveInstanceUsingDataRoot(
  context: vscode.ExtensionContext,
  selfInstanceId: string,
  sourceRootPath: string
): Promise<void> {
  const blockers: DataRootProcessLeaseRecord[] = [];
  const leases = await listDataRootProcessLeases(context);
  for (const lease of leases) {
    if (lease.record.instanceId === selfInstanceId) continue;
    const activeRootPath = lease.record.activeRootPath;
    if (!activeRootPath || !sameFsPath(activeRootPath, sourceRootPath)) continue;
    if (!isLeaseLive(lease.record)) {
      await deleteLeaseUri(lease.uri);
      continue;
    }
    blockers.push(lease.record);
  }

  if (blockers.length === 0) return;
  const details = blockers
    .map((lease) => `instance=${lease.instanceId.slice(0, 8)} pid=${lease.pid} activeRoot=${lease.activeRootPath}`)
    .join('; ');
  throw new Error(`数据目录迁移已中止：检测到其它 LimCode/VS Code 窗口仍在使用源数据目录，请关闭其它窗口后重试。${details ? ` (${details})` : ''}`);
}

async function listDataRootProcessLeases(context: vscode.ExtensionContext): Promise<ListedDataRootProcessLease[]> {
  const root = leasesRootUri(context);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw new Error(`无法检查其它 LimCode/VS Code 窗口的数据目录租约：${error instanceof Error ? error.message : String(error)}`);
  }

  const leases: ListedDataRootProcessLease[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
    const uri = vscode.Uri.joinPath(root, name);
    const result = await readJsonStrict<unknown>(uri);
    if (result.status === 'missing') continue;
    if (result.status === 'ioError') {
      throw new Error(`无法读取其它 LimCode/VS Code 窗口的数据目录租约：${uri.fsPath}`);
    }
    if (result.status === 'invalid') {
      if (await removeInvalidLeaseWhenStale(uri)) continue;
      throw new Error(`检测到尚未过期但内容损坏的数据目录租约，已中止迁移：${uri.fsPath}`);
    }
    const record = parseDataRootProcessLeaseRecord(result.value);
    if (!record) {
      if (await removeInvalidLeaseWhenStale(uri)) continue;
      throw new Error(`检测到尚未过期但结构未知的数据目录租约，已中止迁移：${uri.fsPath}`);
    }
    leases.push({ uri, record });
  }
  return leases;
}

async function removeInvalidLeaseWhenStale(uri: vscode.Uri): Promise<boolean> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (error) {
    if (isFileNotFoundError(error)) return true;
    throw error;
  }
  const timestamp = stat.mtime > 0 ? stat.mtime : stat.ctime;
  if (Math.max(0, Date.now() - timestamp) <= leaseStaleMs()) return false;
  await deleteLeaseUri(uri);
  return true;
}

function parseDataRootProcessLeaseRecord(value: unknown): DataRootProcessLeaseRecord | undefined {
  const record = value as Partial<DataRootProcessLeaseRecord> | undefined;
  if (!record || record.kind !== DATA_ROOT_PROCESS_LEASE_KIND || record.schemaVersion !== STORAGE_VERSION) return undefined;
  if (typeof record.instanceId !== 'string' || !record.instanceId.trim()) return undefined;
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
  if (!isFinitePositiveNumber(record.createdAt) || !isFinitePositiveNumber(record.updatedAt) || !isFinitePositiveNumber(record.heartbeatAt)) return undefined;
  if (typeof record.activeRootPath !== 'string' || !record.activeRootPath.trim()) return undefined;
  const activeOperation = parseDataRootProcessLeaseOperation(record.activeOperation);
  return {
    kind: DATA_ROOT_PROCESS_LEASE_KIND,
    schemaVersion: STORAGE_VERSION,
    instanceId: record.instanceId,
    pid: record.pid,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    heartbeatAt: record.heartbeatAt,
    activeRootPath: record.activeRootPath,
    ...(activeOperation ? { activeOperation } : {})
  };
}

function parseDataRootProcessLeaseOperation(value: unknown): DataRootProcessLeaseOperation | undefined {
  if (value === undefined) return undefined;
  const operation = value as Partial<DataRootProcessLeaseOperation> | undefined;
  if (!operation || typeof operation.kind !== 'string' || !operation.kind.trim() || !isFinitePositiveNumber(operation.startedAt)) return undefined;
  if (operation.targetRootPath !== undefined && typeof operation.targetRootPath !== 'string') return undefined;
  return {
    kind: operation.kind,
    startedAt: operation.startedAt,
    ...(operation.targetRootPath ? { targetRootPath: operation.targetRootPath } : {})
  };
}

function isLeaseLive(record: DataRootProcessLeaseRecord): boolean {
  const heartbeatAgeMs = Math.max(0, Date.now() - record.heartbeatAt);
  return heartbeatAgeMs <= leaseStaleMs() && processIsAlive(record.pid);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

function leasesRootUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, DATA_ROOT_LEASES_DIR);
}

function leaseUri(context: vscode.ExtensionContext, instanceId: string): vscode.Uri {
  return vscode.Uri.joinPath(leasesRootUri(context), `${safeLeaseFileName(instanceId)}.json`);
}

function safeLeaseFileName(instanceId: string): string {
  return instanceId.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

async function deleteLeaseUri(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch {
    // best-effort cleanup only
  }
}

function leaseHeartbeatIntervalMs(): number {
  return normalizePositiveInteger(__dataRootProcessLeaseTestOptions.heartbeatIntervalMs, DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS);
}

function leaseStaleMs(): number {
  return normalizePositiveInteger(__dataRootProcessLeaseTestOptions.staleMs, DEFAULT_LEASE_STALE_MS);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
