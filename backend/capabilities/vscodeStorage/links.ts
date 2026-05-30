import * as vscode from 'vscode';
import type { AgentConversationLinkRecord } from '../../../shared/protocol';
import { RECORDS_DIR, STORAGE_VERSION } from './constants';
import { readJson, writeJson } from './json';
import { sortableName } from './naming';

interface LinksIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: LinkIndexRecord[];
}

interface LinkIndexRecord {
  id: string;
  file: string;
  agentId: string;
  sessionId: string;
  role: AgentConversationLinkRecord['role'];
  updatedAt: string;
}

interface LinkRecordFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  link: AgentConversationLinkRecord;
}

export async function loadLinks(root: vscode.Uri, indexUri: vscode.Uri): Promise<AgentConversationLinkRecord[] | undefined> {
  const index = await readJson<LinksIndexFile>(indexUri);
  if (!index || index.schemaVersion !== STORAGE_VERSION) return undefined;

  const links: AgentConversationLinkRecord[] = [];
  for (const record of index.records) {
    const file = await readJson<LinkRecordFile>(vscode.Uri.joinPath(root, ...record.file.split('/')));
    if (file?.schemaVersion === STORAGE_VERSION) links.push(file.link);
  }
  return links;
}

export async function saveLinks(root: vscode.Uri, indexUri: vscode.Uri, links: AgentConversationLinkRecord[]): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await readJson<LinksIndexFile>(indexUri);
  const previousById = new Map(previousIndex?.records.map((record) => [record.id, record]));

  const records: LinkIndexRecord[] = [];
  for (const link of links) {
    const file = previousById.get(link.id)?.file ?? `${RECORDS_DIR}/${sortableName(link.id, `${link.role}-${link.agentId}-${link.sessionId}`)}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      link
    } satisfies LinkRecordFile);
    records.push({
      id: link.id,
      file,
      agentId: link.agentId,
      sessionId: link.sessionId,
      role: link.role,
      updatedAt: savedAt
    });
  }

  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records
  } satisfies LinksIndexFile);
}
