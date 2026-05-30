import * as vscode from 'vscode';
import type { AgentRecord } from '../../../shared/protocol';
import { RECORDS_DIR, STORAGE_VERSION } from './constants';
import { readJson, writeJson } from './json';
import { sortableName } from './naming';

interface AgentsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: AgentIndexRecord[];
}

interface AgentIndexRecord {
  id: string;
  file: string;
  updatedAt: string;
}

interface AgentRecordFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  agent: AgentRecord;
}

export async function loadAgents(root: vscode.Uri, indexUri: vscode.Uri): Promise<AgentRecord[] | undefined> {
  const index = await readJson<AgentsIndexFile>(indexUri);
  if (!index || index.schemaVersion !== STORAGE_VERSION) return undefined;

  const agents: AgentRecord[] = [];
  for (const record of index.records) {
    const file = await readJson<AgentRecordFile>(vscode.Uri.joinPath(root, ...record.file.split('/')));
    if (file?.schemaVersion === STORAGE_VERSION) agents.push(file.agent);
  }
  return agents;
}

export async function saveAgents(root: vscode.Uri, indexUri: vscode.Uri, agents: AgentRecord[]): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await readJson<AgentsIndexFile>(indexUri);
  const previousById = new Map(previousIndex?.records.map((record) => [record.id, record]));

  const records: AgentIndexRecord[] = [];
  for (const agent of agents) {
    const file = previousById.get(agent.id)?.file ?? `${RECORDS_DIR}/${sortableName(agent.id)}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      agent
    } satisfies AgentRecordFile);
    records.push({ id: agent.id, file, updatedAt: savedAt });
  }

  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records
  } satisfies AgentsIndexFile);
}
