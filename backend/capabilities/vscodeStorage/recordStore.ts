import * as vscode from 'vscode';
import { SettingsRevisionConflictError } from '../settingsRevisionConflict';
import { INDEX_FILE, RECORDS_DIR, STORAGE_VERSION } from './constants';
import { isFileNotFoundError, readJson, readJsonStrict, writeJson } from './json';
import { sortableName } from './naming';
import { withStorageResourceLock } from './storageResourceLock';
import { deleteStorageUri, ensureStorageDirectory, readStorageDirectory } from './storageFs';
import { createMissingStorageRevision, createStorageRevision } from './storageRevision';
import { assertSafeStorageGenerationId, getStorageGenerationRootUri } from './storageGeneration';

interface RecordsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: RecordIndexRecord[];
}

export interface RecordIndexRecord {
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

export interface RecordStoreSnapshot<TRecord> {
  records: TRecord[];
  revision: string;
}

export interface RecordStoreCommitResult<TRecord> extends RecordStoreSnapshot<TRecord> {
  previousRecords: TRecord[];
}

export interface RecordStoreGenerationRef {
  generation: string;
  revision: string;
}

interface RecordStoreGenerationIndex {
  kind: 'recordStore.generation';
  schemaVersion: typeof STORAGE_VERSION;
  storeKey: string;
  generation: string;
  revision: string;
  savedAt: string;
  records: Array<{ id: string; file: string; recordRevision: string }>;
}

interface RecordStoreGenerationRecordFile<TKey extends string, TRecord> {
  kind: 'recordStore.generationRecord';
  schemaVersion: typeof STORAGE_VERSION;
  storeKey: string;
  generation: string;
  recordRevision: string;
  savedAt: string;
  record: Record<TKey, TRecord>;
}

export interface CommitRecordStoreSnapshotOptions extends SaveRecordStoreOptions {
  /** 调用方读取快照时拿到的 opaque revision；普通提交必须提供。 */
  expectedRevision: string;
  /** 冲突错误中使用的稳定领域 section。 */
  section: string;
}

export interface RecordStoreReadHookContext {
  root: vscode.Uri;
  indexUri: vscode.Uri;
  recordKey: string;
  attempt: number;
  records: readonly RecordIndexRecord[];
}

export interface RecordStoreTestHooks {
  /** 测试专用：reader 读取 index 后、读取 record files 前触发，用于模拟 prune 竞态。 */
  afterLoadIndexBeforeReadFiles?: (context: RecordStoreReadHookContext) => void | Promise<void>;
}

export const __recordStoreTestHooks: RecordStoreTestHooks = {};

const LOAD_RECORD_BATCH_SIZE = 32;
const RECORD_STORE_READ_MAX_ATTEMPTS = 3;
const RECORD_STORE_LOCK_STALE_MS = 30 * 60_000;
const RECORD_STORE_LOCK_WAIT_MS = 5 * 60_000;

export async function loadRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<TRecord[] | undefined> {
  for (let attempt = 1; attempt <= RECORD_STORE_READ_MAX_ATTEMPTS; attempt += 1) {
    const index = await loadRecordsIndex(indexUri, true);
    if (!index) return undefined;

    await __recordStoreTestHooks.afterLoadIndexBeforeReadFiles?.({ root, indexUri, recordKey, attempt, records: index.records });

    try {
      const files = await loadRecordFilesInBatches<TRecord, TKey>(root, index.records, recordKey, true);
      const records: TRecord[] = [];
      for (const record of files) {
        if (record) records.push(record);
      }
      return records;
    } catch (error) {
      if (attempt < RECORD_STORE_READ_MAX_ATTEMPTS && await recordStoreIndexChanged(indexUri, index)) continue;
      throw error;
    }
  }
  throw new Error(`Failed to load record store after retries: ${indexUri.fsPath}`);
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
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];

  for (let attempt = 1; attempt <= RECORD_STORE_READ_MAX_ATTEMPTS; attempt += 1) {
    const index = await loadRecordsIndex(indexUri, true);
    if (!index) return [];

    await __recordStoreTestHooks.afterLoadIndexBeforeReadFiles?.({ root, indexUri, recordKey, attempt, records: index.records });

    const indexById = new Map(index.records.map((record) => [record.id, record]));
    const wantedRecords = [...wanted].map((id) => indexById.get(id)).filter((record): record is RecordIndexRecord => record !== undefined);
    try {
      const files = await loadRecordFilesInBatches<TRecord, TKey>(root, wantedRecords, recordKey, true);
      const records: TRecord[] = [];
      for (const record of files) {
        if (record) records.push(record);
      }
      return records;
    } catch (error) {
      if (attempt < RECORD_STORE_READ_MAX_ATTEMPTS && await recordStoreIndexChanged(indexUri, index)) continue;
      throw error;
    }
  }
  throw new Error(`Failed to load record store by ids after retries: ${indexUri.fsPath}`);
}


export async function withRecordStoreTransaction<T>(lockUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  return withRecordStoreMutationLock(lockUri, action);
}

/**
 * 在 mutation lock 内一次性读取 records 与其 revision，避免“旧 records + 新 revision”撕裂快照。
 * snapshot 读取使用严格模式；index 缺失但 records 仍存在时拒绝把孤儿数据当作空 store。
 */
export async function loadRecordStoreSnapshot<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<RecordStoreSnapshot<TRecord> | undefined> {
  return withRecordStoreMutationLock(indexUri, () => loadRecordStoreSnapshotUnlocked<TRecord, TKey>(root, indexUri, recordKey));
}

/** 尚未创建 index 的 record store revision，仅供显式初始化 CAS 使用。 */
export function missingRecordStoreRevision(indexUri: vscode.Uri): string {
  return createMissingStorageRevision(`record-store:${indexUri.toString()}`);
}

/**
 * 基于一致快照提交完整 record 集合。调用方必须携带 base revision；比较、写入与返回
 * next revision 都在同一把锁内完成。普通业务不再允许省略 revision 退化为无条件覆盖。
 */
export async function commitRecordStoreSnapshot<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string,
  options: CommitRecordStoreSnapshotOptions
): Promise<RecordStoreCommitResult<TRecord>> {
  return withRecordStoreMutationLock(indexUri, async () => {
    const current = await loadRecordStoreSnapshotUnlocked<TRecord, TKey>(root, indexUri, recordKey);
    const actualRevision = current?.revision ?? missingRecordStoreRevision(indexUri);
    if (actualRevision !== options.expectedRevision) {
      throw new SettingsRevisionConflictError(options.section, options.expectedRevision, actualRevision);
    }

    await saveRecordStoreUnlocked(root, indexUri, records, recordKey, labelForRecord, {
      pruneMissing: options.pruneMissing
    });
    return {
      records: [...records],
      revision: createStorageRevision(records),
      previousRecords: [...(current?.records ?? [])]
    };
  });
}

async function loadRecordStoreSnapshotUnlocked<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<RecordStoreSnapshot<TRecord> | undefined> {
  const index = await loadRecordsIndex(indexUri, true);
  if (!index) {
    const traces = await listRecordFiles(root);
    if (traces.length > 0) {
      throw new Error(`Record store index is missing while record files still exist: ${indexUri.fsPath}`);
    }
    return undefined;
  }

  const files = await loadRecordFilesInBatches<TRecord, TKey>(root, index.records, recordKey, true);
  const records = files.filter((record): record is TRecord => record !== undefined);
  return { records, revision: createStorageRevision(records) };
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
  await ensureStorageDirectory(recordsRoot);
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
  await ensureStorageDirectory(recordsRoot);
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
      await deleteStorageUri(vscode.Uri.joinPath(root, ...removed.file.split('/')));
    } catch (error) {
      if (!isFileNotFoundError(error)) console.warn(`[LimCode] Failed to delete record file: ${removed.file}`, error);
    }
  }
}

/**
 * 为 skeleton coordinator 准备不可变领域 generation。该函数不发布 root index、
 * 不 prune，也绝不修改已存在 generation；generation index 是该目录最后一个写入点。
 */
export async function prepareRecordStoreGeneration<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string,
  options: { storeKey: string; generation: string }
): Promise<RecordStoreGenerationRef> {
  const generation = assertSafeStorageGenerationId(options.generation);
  const generationRoot = getStorageGenerationRootUri(root, generation);
  const recordsRoot = vscode.Uri.joinPath(generationRoot, RECORDS_DIR);
  await ensureStorageDirectory(recordsRoot);

  const ids = new Set<string>();
  const files = new Set<string>();
  const indexRecords: RecordStoreGenerationIndex['records'] = [];
  const savedAt = new Date().toISOString();
  for (const record of records) {
    if (!record.id.trim() || ids.has(record.id)) throw new Error(`Duplicate or empty record id in ${options.storeKey}: ${record.id}`);
    ids.add(record.id);
    const file = `${RECORDS_DIR}/${sortableName(record.id, labelForRecord(record))}.json`;
    if (files.has(file)) throw new Error(`Duplicate generation record path in ${options.storeKey}: ${file}`);
    files.add(file);
    const recordRevision = createStorageRevision(record);
    await writeJson(vscode.Uri.joinPath(generationRoot, ...file.split('/')), {
      kind: 'recordStore.generationRecord',
      schemaVersion: STORAGE_VERSION,
      storeKey: options.storeKey,
      generation,
      recordRevision,
      savedAt,
      record: { [recordKey]: record } as Record<TKey, TRecord>
    } satisfies RecordStoreGenerationRecordFile<TKey, TRecord>);
    indexRecords.push({ id: record.id, file, recordRevision });
  }

  const revision = createStorageRevision(records);
  await writeJson(vscode.Uri.joinPath(generationRoot, INDEX_FILE), {
    kind: 'recordStore.generation',
    schemaVersion: STORAGE_VERSION,
    storeKey: options.storeKey,
    generation,
    revision,
    savedAt,
    records: indexRecords
  } satisfies RecordStoreGenerationIndex);
  return { generation, revision };
}

/** 严格读取 coordinator manifest 指定的 immutable generation，并逐 record 校验 hash。 */
export async function loadRecordStoreGeneration<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  ref: RecordStoreGenerationRef,
  recordKey: TKey,
  storeKey: string
): Promise<RecordStoreSnapshot<TRecord>> {
  const generation = assertSafeStorageGenerationId(ref.generation);
  const generationRoot = getStorageGenerationRootUri(root, generation);
  const indexUri = vscode.Uri.joinPath(generationRoot, INDEX_FILE);
  const indexResult = await readJsonStrict<unknown>(indexUri);
  if (indexResult.status !== 'ok') throw new Error(`Record store generation index is unavailable: ${indexUri.fsPath}`);
  const index = parseRecordStoreGenerationIndex(indexResult.value, indexUri, storeKey, generation);
  if (index.revision !== ref.revision) {
    throw new Error(`Record store generation revision mismatch for ${storeKey}: expected=${ref.revision}, actual=${index.revision}`);
  }

  const records: TRecord[] = [];
  for (const entry of index.records) {
    const fileUri = vscode.Uri.joinPath(generationRoot, ...entry.file.split('/'));
    const fileResult = await readJsonStrict<unknown>(fileUri);
    if (fileResult.status !== 'ok') throw new Error(`Record store generation file is unavailable: ${fileUri.fsPath}`);
    const record = parseRecordStoreGenerationRecord<TRecord, TKey>(
      fileResult.value,
      fileUri,
      recordKey,
      storeKey,
      generation,
      entry.id,
      entry.recordRevision
    );
    records.push(record);
  }
  const actualRevision = createStorageRevision(records);
  if (actualRevision !== index.revision) {
    throw new Error(`Record store generation content hash mismatch for ${storeKey}: expected=${index.revision}, actual=${actualRevision}`);
  }
  return { records, revision: actualRevision };
}

function parseRecordStoreGenerationIndex(
  value: unknown,
  uri: vscode.Uri,
  storeKey: string,
  generation: string
): RecordStoreGenerationIndex {
  const candidate = isPlainRecord(value) ? value : undefined;
  if (!candidate || !hasOnlyKeys(candidate, ['kind', 'schemaVersion', 'storeKey', 'generation', 'revision', 'savedAt', 'records'])) {
    throw new Error(`Record store generation index structure is invalid: ${uri.fsPath}`);
  }
  if (candidate.kind !== 'recordStore.generation' || candidate.schemaVersion !== STORAGE_VERSION
    || candidate.storeKey !== storeKey || candidate.generation !== generation
    || typeof candidate.revision !== 'string' || !candidate.revision
    || typeof candidate.savedAt !== 'string' || !Array.isArray(candidate.records)) {
    throw new Error(`Record store generation index metadata is invalid: ${uri.fsPath}`);
  }
  const records: RecordStoreGenerationIndex['records'] = [];
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const raw of candidate.records) {
    const record = isPlainRecord(raw) ? raw : undefined;
    if (!record || !hasOnlyKeys(record, ['id', 'file', 'recordRevision'])
      || typeof record.id !== 'string' || !record.id.trim() || ids.has(record.id)
      || typeof record.file !== 'string' || !isRecordFilePath(record.file) || files.has(record.file)
      || typeof record.recordRevision !== 'string' || !record.recordRevision) {
      throw new Error(`Record store generation index record is invalid: ${uri.fsPath}`);
    }
    ids.add(record.id);
    files.add(record.file);
    records.push({ id: record.id, file: record.file, recordRevision: record.recordRevision });
  }
  return {
    kind: 'recordStore.generation',
    schemaVersion: STORAGE_VERSION,
    storeKey,
    generation,
    revision: candidate.revision,
    savedAt: candidate.savedAt,
    records
  };
}

function parseRecordStoreGenerationRecord<TRecord extends { id: string }, TKey extends string>(
  value: unknown,
  uri: vscode.Uri,
  recordKey: TKey,
  storeKey: string,
  generation: string,
  expectedId: string,
  expectedRevision: string
): TRecord {
  const candidate = isPlainRecord(value) ? value : undefined;
  if (!candidate || !hasOnlyKeys(candidate, ['kind', 'schemaVersion', 'storeKey', 'generation', 'recordRevision', 'savedAt', 'record'])) {
    throw new Error(`Record store generation record structure is invalid: ${uri.fsPath}`);
  }
  const wrapped = isPlainRecord(candidate.record) ? candidate.record : undefined;
  const record = wrapped?.[recordKey];
  if (candidate.kind !== 'recordStore.generationRecord' || candidate.schemaVersion !== STORAGE_VERSION
    || candidate.storeKey !== storeKey || candidate.generation !== generation
    || candidate.recordRevision !== expectedRevision || typeof candidate.savedAt !== 'string'
    || !wrapped || !hasOnlyKeys(wrapped, [recordKey]) || !isStoreRecord(record) || record.id !== expectedId
    || createStorageRevision(record) !== expectedRevision) {
    throw new Error(`Record store generation record metadata/hash is invalid: ${uri.fsPath}`);
  }
  return record as TRecord;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key)) && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
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
    const entries = await readStorageDirectory(recordsRoot);
    return entries
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([name]) => `${RECORDS_DIR}/${name}`)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .sort();
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

async function deleteRecordFile(root: vscode.Uri, file: string): Promise<void> {
  try {
    await deleteStorageUri(vscode.Uri.joinPath(root, ...file.split('/')));
  } catch (error) {
    if (!isFileNotFoundError(error)) console.warn(`[LimCode] Failed to prune record file: ${file}`, error);
  }
}


async function withRecordStoreMutationLock<T>(indexUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  return withStorageResourceLock(indexUri, action, {
    waitMs: RECORD_STORE_LOCK_WAIT_MS,
    staleMs: RECORD_STORE_LOCK_STALE_MS
  });
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

async function recordStoreIndexChanged(indexUri: vscode.Uri, previous: RecordsIndexFile): Promise<boolean> {
  try {
    const current = await loadRecordsIndex(indexUri, true);
    return !sameRecordsIndexFile(previous, current);
  } catch (error) {
    console.warn(`[LimCode] Failed to re-read record store index after record file read failure: ${indexUri.fsPath}`, error);
    return false;
  }
}

function sameRecordsIndexFile(left: RecordsIndexFile | undefined, right: RecordsIndexFile | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.schemaVersion !== right.schemaVersion || left.savedAt !== right.savedAt || left.records.length !== right.records.length) return false;
  for (let index = 0; index < left.records.length; index += 1) {
    const a = left.records[index];
    const b = right.records[index];
    if (a.id !== b.id || a.file !== b.file || a.updatedAt !== b.updatedAt) return false;
  }
  return true;
}

async function loadRecordsIndex(indexUri: vscode.Uri, strict: boolean): Promise<RecordsIndexFile | undefined> {
  const result = await readJsonStrict<RecordsIndexFile>(indexUri);
  if (result.status === 'missing') return undefined;
  if (result.status === 'invalid' || result.status === 'ioError') {
    if (strict) throw result.error;
    return undefined;
  }

  const normalized = normalizeRecordsIndexFile(result.value);
  if (normalized) return normalized.index;
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
