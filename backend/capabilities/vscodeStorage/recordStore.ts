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
    if (!record || seenIds.has(record.id)) continue;
    records.push(record);
    seenIds.add(record.id);
  }

  const recordFiles = await listRecordFiles(root);
  const orphanIds: string[] = [];
  for (const file of recordFiles) {
    if (indexedFiles.has(file)) continue;
    const loaded = await loadRecordFile<TRecord, TKey>(root, file, recordKey);
    if (!loaded || seenIds.has(loaded.id)) continue;
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


export async function saveRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string = (record) => record.id,
  options: SaveRecordStoreOptions = {}
): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await loadRecordsIndex(indexUri, true);
  await preflightRecordStore<TRecord, TKey>(root, previousIndex, recordKey);
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
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await loadRecordsIndex(indexUri, true);
  await preflightRecordStore<TRecord, TKey>(root, previousIndex, recordKey);
  const previousRecords = previousIndex?.records ?? [];
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
  const savedAt = new Date().toISOString();
  const previousIndex = await loadRecordsIndex(indexUri, true);
  if (!previousIndex) return;
  await preflightRecordStore<{ id: string }, string>(root, previousIndex, recordKey);

  const removed = previousIndex.records.find((record) => record.id === id);
  const nextRecords = previousIndex.records.filter((record) => record.id !== id);
  if (nextRecords.length === previousIndex.records.length) return;

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


async function preflightRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  index: RecordsIndexFile | undefined,
  recordKey: TKey
): Promise<void> {
  if (!index || index.records.length === 0) return;
  await loadRecordFilesInBatches<TRecord, TKey>(root, index.records, recordKey, true);
}

async function loadRecordsIndex(indexUri: vscode.Uri, strict: boolean): Promise<RecordsIndexFile | undefined> {
  const index = await readJson<RecordsIndexFile>(indexUri, { throwOnError: strict });
  if (index === undefined) return undefined;
  if (isRecordsIndexFile(index)) return index;
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

function isRecordsIndexFile(value: unknown): value is RecordsIndexFile {
  const candidate = value as Partial<RecordsIndexFile> | undefined;
  if (!candidate || candidate.schemaVersion !== STORAGE_VERSION || !Array.isArray(candidate.records)) return false;
  const ids = new Set<string>();
  const files = new Set<string>();
  return candidate.records.every((record) => {
    if (!record || typeof record.id !== 'string' || !record.id.trim()) return false;
    if (typeof record.file !== 'string' || !isRecordFilePath(record.file)) return false;
    if (typeof record.updatedAt !== 'string' || !record.updatedAt) return false;
    if (ids.has(record.id) || files.has(record.file)) return false;
    ids.add(record.id);
    files.add(record.file);
    return true;
  });
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
