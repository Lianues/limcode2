import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RECORDS_DIR, STORAGE_VERSION } from './constants';
import { readJson, writeJson } from './json';
import { sortableName } from './naming';

interface RecordsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: RecordIndexRecord[];
}

interface RecordIndexRecord {
  id: string;
  file: string;
  updatedAt: string;
}

export interface RecordStoreDiagnosticsResult<TRecord> {
  records: TRecord[];
  indexCount: number;
  recordFileCount: number;
  indexedIds: string[];
  orphanIds: string[];
}

type RecordFile<TKey extends string, TRecord> = {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
} & Record<TKey, TRecord>;

export interface SaveRecordStoreOptions {
  pruneMissing?: boolean;
}

const LOAD_RECORD_BATCH_SIZE = 32;
const RECORD_STORE_LOCK_STALE_MS = 30 * 60_000;
const RECORD_STORE_LOCK_WAIT_MS = 5 * 60_000;
const recordStoreMutationQueues = new Map<string, Promise<void>>();

export async function loadRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<TRecord[] | undefined> {
  const index = await loadRecordsIndex(indexUri, true);
  if (!index) return undefined;

  const files = await loadRecordFilesInBatches<TRecord, TKey>(root, index.records, recordKey, true);
  const records: TRecord[] = [];
  for (const record of files) {
    if (record) records.push(record);
  }
  return records;
}

export async function loadRecordStoreWithDiagnostics<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<RecordStoreDiagnosticsResult<TRecord>> {
  const index = await loadRecordsIndex(indexUri, false);
  const indexRecords = index?.records ?? [];
  const indexedIds = indexRecords.map((record) => record.id);
  const indexedFiles = new Set(indexRecords.map((record) => record.file));
  const indexed = await loadRecordFilesInBatches<TRecord, TKey>(root, indexRecords, recordKey);
  const records: TRecord[] = [];
  const seenIds = new Set<string>();
  for (const record of indexed) {
    if (!record) continue;
    if (seenIds.has(record.id)) throw new Error(`Duplicate ${recordKey} id in record store: ${record.id}`);
    records.push(record);
    seenIds.add(record.id);
  }

  const recordFiles = await listRecordFiles(root);
  const orphanIds: string[] = [];
  for (const file of recordFiles) {
    if (indexedFiles.has(file)) continue;
    const loaded = await loadRecordFile<TRecord, TKey>(root, file, recordKey);
    if (!loaded) continue;
    if (seenIds.has(loaded.id)) throw new Error(`Duplicate ${recordKey} id in record store: ${loaded.id}`);
    records.push(loaded);
    seenIds.add(loaded.id);
    orphanIds.push(loaded.id);
  }

  return {
    records,
    indexCount: indexRecords.length,
    recordFileCount: recordFiles.length,
    indexedIds,
    orphanIds
  };
}

export async function loadRecordStoreByIds<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey,
  ids: Iterable<string>
): Promise<TRecord[]> {
  const index = await loadRecordsIndex(indexUri, true);
  if (!index) return [];

  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  const indexById = new Map(index.records.map((record) => [record.id, record]));
  const wantedRecords = [...wanted].map((id) => indexById.get(id)).filter((record): record is RecordIndexRecord => record !== undefined);
  const files = await loadRecordFilesInBatches<TRecord, TKey>(root, wantedRecords, recordKey, true);
  const records: TRecord[] = [];
  for (const record of files) {
    if (record) records.push(record);
  }
  return records;
}


export async function withRecordStoreTransaction<T>(lockUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  return withRecordStoreMutationLock(lockUri, action);
}

export async function saveRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string = (record) => record.id,
  options: SaveRecordStoreOptions = {}
): Promise<void> {
  return withRecordStoreMutationLock(indexUri, () => saveRecordStoreUnlocked(root, indexUri, records, recordKey, labelForRecord, options));
}

async function saveRecordStoreUnlocked<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string,
  options: SaveRecordStoreOptions
): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  // 全量保存本身会重写所有 next records，因此不能让历史索引中的空/缺失文件永久阻断修复。
  // 在 mutation lock 内复用旧文件名；若旧文件已丢失，下面的原子 writeJson 会直接重建。
  const previousIndex = await loadRecordsIndex(indexUri, false);
  const previousRecords = previousIndex?.records ?? [];
  const previousById = new Map(previousRecords.map((record) => [record.id, record]));

  const nextIndexRecords: RecordIndexRecord[] = [];
  for (const record of records) {
    const file = previousById.get(record.id)?.file ?? `${RECORDS_DIR}/${sortableName(record.id, labelForRecord(record))}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      [recordKey]: record
    } as RecordFile<TKey, TRecord>);
    nextIndexRecords.push({ id: record.id, file, updatedAt: savedAt });
  }

  // 先发布新索引，再清理旧文件；并发读取者只会看到“旧索引 + 完整旧文件”或新索引。
  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records: nextIndexRecords
  } satisfies RecordsIndexFile);

  if (options.pruneMissing) {
    const nextFiles = new Set(nextIndexRecords.map((record) => record.file));
    const existingFiles = await listRecordFiles(root);
    await Promise.all(existingFiles
      .filter((file) => !nextFiles.has(file))
      .map((file) => deleteRecordFile(root, file)));
  }
}


export async function upsertRecordStoreRecords<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string = (record) => record.id
): Promise<void> {
  return withRecordStoreMutationLock(indexUri, () => upsertRecordStoreRecordsUnlocked(root, indexUri, records, recordKey, labelForRecord));
}

async function upsertRecordStoreRecordsUnlocked<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string
): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await loadRecordsIndex(indexUri, false);
  const previousRecords = await readableIndexRecords(root, previousIndex?.records ?? [], recordKey);
  const nextById = new Map(previousRecords.map((record) => [record.id, record]));

  for (const record of records) {
    const file = nextById.get(record.id)?.file ?? `${RECORDS_DIR}/${sortableName(record.id, labelForRecord(record))}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      [recordKey]: record
    } as RecordFile<TKey, TRecord>);
    nextById.set(record.id, { id: record.id, file, updatedAt: savedAt });
  }

  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records: [...nextById.values()]
  } satisfies RecordsIndexFile);
}


export async function removeRecordStoreRecord(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  id: string,
  recordKey: string
): Promise<void> {
  return withRecordStoreMutationLock(indexUri, () => removeRecordStoreRecordUnlocked(root, indexUri, id, recordKey));
}

async function removeRecordStoreRecordUnlocked(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  id: string,
  recordKey: string
): Promise<void> {
  const savedAt = new Date().toISOString();
  const previousIndex = await loadRecordsIndex(indexUri, false);
  if (!previousIndex) return;
  const readableRecords = await readableIndexRecords(root, previousIndex.records, recordKey);

  const removed = readableRecords.find((record) => record.id === id);
  const nextRecords = readableRecords.filter((record) => record.id !== id);
  if (!removed && nextRecords.length === previousIndex.records.length) return;

  // 删除也先提交索引，避免旧索引在短窗口内指向已删除文件。
  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records: nextRecords
  } satisfies RecordsIndexFile);

  if (removed) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ...removed.file.split('/')));
    } catch (error) {
      if (!isFileNotFound(error)) console.warn(`[LimCode] Failed to delete record file: ${removed.file}`, error);
    }
  }
}

async function loadRecordFilesInBatches<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  records: RecordIndexRecord[],
  recordKey: TKey,
  strict = false
): Promise<Array<TRecord | undefined>> {
  const result: Array<TRecord | undefined> = [];
  for (let index = 0; index < records.length; index += LOAD_RECORD_BATCH_SIZE) {
    const batch = records.slice(index, index + LOAD_RECORD_BATCH_SIZE);
    const files = await Promise.all(batch.map(async (record) => {
      return loadRecordFile<TRecord, TKey>(root, record.file, recordKey, strict, record.id);
    }));
    result.push(...files);
    if (index + batch.length < records.length) {
      await yieldToExtensionHost();
    }
  }
  return result;
}

async function loadRecordFile<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  file: string,
  recordKey: TKey,
  strict = false,
  expectedId?: string
): Promise<TRecord | undefined> {
  const fileUri = vscode.Uri.joinPath(root, ...file.split('/'));
  const recordFile = await readJson<RecordFile<TKey, TRecord>>(fileUri, { throwOnError: strict });
  const candidate = recordFile?.schemaVersion === STORAGE_VERSION ? recordFile[recordKey] : undefined;
  const record = isStoreRecord(candidate) ? candidate : undefined;
  if (strict && (!record || expectedId !== undefined && record.id !== expectedId)) {
    throw new Error(`Indexed record file is missing or invalid: ${fileUri.fsPath}`);
  }
  return record;
}

async function listRecordFiles(root: vscode.Uri): Promise<string[]> {
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  try {
    const entries = await vscode.workspace.fs.readDirectory(recordsRoot);
    return entries
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([name]) => `${RECORDS_DIR}/${name}`)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .sort();
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

async function deleteRecordFile(root: vscode.Uri, file: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ...file.split('/')));
  } catch (error) {
    if (!isFileNotFound(error)) console.warn(`[LimCode] Failed to prune record file: ${file}`, error);
  }
}


async function withRecordStoreMutationLock<T>(indexUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  const key = indexUri.toString(true);
  const previous = recordStoreMutationQueues.get(key) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const queue = previous.catch(() => undefined).then(() => turn);
  recordStoreMutationQueues.set(key, queue);

  await previous.catch(() => undefined);
  try {
    return await withCrossProcessRecordStoreLock(indexUri, action);
  } finally {
    releaseTurn();
    if (recordStoreMutationQueues.get(key) === queue) recordStoreMutationQueues.delete(key);
  }
}

async function withCrossProcessRecordStoreLock<T>(indexUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  if (indexUri.scheme !== 'file') return action();

  const lockPath = `${indexUri.fsPath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + RECORD_STORE_LOCK_WAIT_MS;
  let handle: fs.FileHandle | undefined;

  while (!handle) {
    try {
      const candidate = await fs.open(lockPath, 'wx');
      try {
        await candidate.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), indexPath: indexUri.fsPath }), 'utf8');
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (await removeStaleRecordStoreLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for record store lock: ${indexUri.fsPath}`);
      await delay(25);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function removeStaleRecordStoreLock(lockPath: string): Promise<boolean> {
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(lockPath, 'utf8').catch(() => ''),
      fs.stat(lockPath)
    ]);
    const metadata = parseRecordStoreLockMetadata(raw);
    const pid = typeof metadata?.pid === 'number' && Number.isInteger(metadata.pid) ? metadata.pid : undefined;
    if (pid !== undefined && processIsAlive(pid)) return false;
    const createdAt = typeof metadata?.createdAt === 'number' && Number.isFinite(metadata.createdAt) ? metadata.createdAt : stat.mtimeMs;
    if (Date.now() - createdAt < RECORD_STORE_LOCK_STALE_MS && pid === undefined) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return true;
    return false;
  }
}

function parseRecordStoreLockMetadata(raw: string): { pid?: unknown; createdAt?: unknown } | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EEXIST';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readableIndexRecords<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  records: RecordIndexRecord[],
  recordKey: TKey
): Promise<RecordIndexRecord[]> {
  if (records.length === 0) return [];
  const loaded = await loadRecordFilesInBatches<TRecord, TKey>(root, records, recordKey);
  return records.filter((record, index) => loaded[index]?.id === record.id);
}

async function loadRecordsIndex(indexUri: vscode.Uri, strict: boolean): Promise<RecordsIndexFile | undefined> {
  const index = await readJson<RecordsIndexFile>(indexUri, { throwOnError: strict });
  if (index === undefined) return undefined;
  const normalized = normalizeRecordsIndexFile(index);
  if (normalized) {
    if (normalized.repaired) await writeJson(indexUri, normalized.index);
    return normalized.index;
  }
  if (strict) throw new Error(`Record store index is invalid: ${indexUri.fsPath}`);
  return undefined;
}

function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}

interface NormalizedRecordsIndexResult {
  index: RecordsIndexFile;
  repaired: boolean;
}

function normalizeRecordsIndexFile(value: unknown): NormalizedRecordsIndexResult | undefined {
  const candidate = value as Partial<RecordsIndexFile> | undefined;
  if (!candidate || candidate.schemaVersion !== STORAGE_VERSION || typeof candidate.savedAt !== 'string' || !Array.isArray(candidate.records)) return undefined;

  const validRecords: RecordIndexRecord[] = [];
  for (const record of candidate.records) {
    if (isRecordIndexRecord(record)) validRecords.push({ id: record.id, file: record.file, updatedAt: record.updatedAt });
  }

  const byId = new Map<string, RecordIndexRecord>();
  for (const record of validRecords) {
    if (byId.has(record.id)) byId.delete(record.id);
    byId.set(record.id, record);
  }

  const byFile = new Map<string, RecordIndexRecord>();
  for (const record of byId.values()) {
    if (byFile.has(record.file)) byFile.delete(record.file);
    byFile.set(record.file, record);
  }

  const records = [...byFile.values()];
  return {
    index: { schemaVersion: STORAGE_VERSION, savedAt: candidate.savedAt, records },
    repaired: records.length !== candidate.records.length
  };
}

function isRecordIndexRecord(value: unknown): value is RecordIndexRecord {
  const record = value as Partial<RecordIndexRecord> | undefined;
  return !!record
    && typeof record.id === 'string'
    && !!record.id.trim()
    && typeof record.file === 'string'
    && isRecordFilePath(record.file)
    && typeof record.updatedAt === 'string'
    && !!record.updatedAt;
}

function isRecordFilePath(file: string): boolean {
  const parts = file.split('/');
  return parts.length === 2
    && parts[0] === RECORDS_DIR
    && !!parts[1]
    && parts[1].toLowerCase().endsWith('.json')
    && !parts[1].includes('\\');
}

function isStoreRecord(value: unknown): value is { id: string } {
  return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && !!(value as { id: string }).id.trim();
}

function isFileNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const text = [candidate.name, candidate.code, candidate.message, candidate.stack, String(error)]
    .filter((part): part is string => typeof part === 'string').join('\n');
  return /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|not found|no such file|不存在|无法解析不存在的文件/i.test(text);
}
