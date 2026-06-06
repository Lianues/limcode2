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

type RecordFile<TKey extends string, TRecord> = {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
} & Record<TKey, TRecord>;

export async function loadRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<TRecord[] | undefined> {
  const index = await readJson<RecordsIndexFile>(indexUri);
  if (!isRecordsIndexFile(index)) return undefined;

  const records: TRecord[] = [];
  const files = await Promise.all(index.records.map(async (record) => {
    const file = await readJson<RecordFile<TKey, TRecord>>(vscode.Uri.joinPath(root, ...record.file.split('/')));
    return file?.schemaVersion === STORAGE_VERSION ? file[recordKey] : undefined;
  }));
  for (const record of files) {
    if (record) records.push(record);
  }
  return records;
}

export async function loadRecordStoreByIds<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey,
  ids: Iterable<string>
): Promise<TRecord[]> {
  const index = await readJson<RecordsIndexFile>(indexUri);
  if (!isRecordsIndexFile(index)) return [];

  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  const indexById = new Map(index.records.map((record) => [record.id, record]));
  const records: TRecord[] = [];
  const files = await Promise.all([...wanted].map(async (id) => {
    const record = indexById.get(id);
    if (!record) return undefined;
    const file = await readJson<RecordFile<TKey, TRecord>>(vscode.Uri.joinPath(root, ...record.file.split('/')));
    return file?.schemaVersion === STORAGE_VERSION ? file[recordKey] : undefined;
  }));
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
  labelForRecord: (record: TRecord) => string = (record) => record.id
): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await readJson<RecordsIndexFile>(indexUri);
  const previousRecords = isRecordsIndexFile(previousIndex) ? previousIndex.records : [];
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

  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records: nextIndexRecords
  } satisfies RecordsIndexFile);
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
  const previousIndex = await readJson<RecordsIndexFile>(indexUri);
  const previousRecords = isRecordsIndexFile(previousIndex) ? previousIndex.records : [];
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



function isRecordsIndexFile(value: RecordsIndexFile | undefined): value is RecordsIndexFile {
  if (!value || value.schemaVersion !== STORAGE_VERSION || !Array.isArray(value.records)) return false;
  return value.records.every((record) => {
    return !!record
      && typeof record.id === 'string'
      && typeof record.file === 'string'
      && typeof record.updatedAt === 'string';
  });
}
