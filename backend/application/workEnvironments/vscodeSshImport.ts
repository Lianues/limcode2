import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WorkEnvironmentRecord } from '../../../shared/protocol';
import { createRemoteServerWorkEnvironmentRecord } from '../../../shared/workEnvironmentCatalog';

interface SshConfigEntry {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export async function loadRemoteServerWorkEnvironmentRecordsFromVscode(): Promise<WorkEnvironmentRecord[]> {
  const configFiles = resolveVscodeSshConfigFiles();
  const byId = new Map<string, WorkEnvironmentRecord>();
  for (const file of configFiles) {
    const entries = await readSshConfigEntries(file);
    for (const entry of entries) {
      const record = sshEntryToWorkEnvironmentRecord(entry);
      byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
}

function resolveVscodeSshConfigFiles(): string[] {
  const config = vscode.workspace.getConfiguration('remote.SSH');
  const configured = config.get<string | string[]>('configFile');
  const files: string[] = [];
  const push = (value: string | undefined): void => {
    const normalized = normalizeConfigPath(value);
    if (normalized && !files.includes(normalized)) files.push(normalized);
  };
  if (Array.isArray(configured)) {
    for (const item of configured) push(item);
  } else {
    push(configured);
  }
  push(path.join(os.homedir(), '.ssh', 'config'));
  return files;
}

async function readSshConfigEntries(filePath: string): Promise<SshConfigEntry[]> {
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const entries: SshConfigEntry[] = [];
  let currentHosts: string[] = [];
  let current: Partial<SshConfigEntry> = {};
  const flush = (): void => {
    for (const host of currentHosts) {
      if (!host || /[*?]/.test(host)) continue;
      const entry: SshConfigEntry = {
        host,
        ...(current.user ? { user: current.user } : {}),
        ...(current.port !== undefined ? { port: current.port } : {}),
        ...(current.identityFile ? { identityFile: current.identityFile } : {})
      };
      entries.push(entry);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripSshConfigComment(rawLine).trim();
    if (!line) continue;
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'host') {
      flush();
      currentHosts = value.split(/\s+/).filter(Boolean);
      current = {};
      continue;
    }
    if (currentHosts.length === 0) continue;
    if (key === 'user') current.user = value;
    else if (key === 'port') {
      const port = Number.parseInt(value, 10);
      if (Number.isFinite(port) && port > 0) current.port = port;
    } else if (key === 'identityfile') current.identityFile = expandHome(value);
  }
  flush();
  return entries;
}

function sshEntryToWorkEnvironmentRecord(entry: SshConfigEntry): WorkEnvironmentRecord {
  return createRemoteServerWorkEnvironmentRecord({
    host: entry.host,
    name: entry.host,
    source: 'vscodeSshConfig',
    ...(entry.port !== undefined ? { port: entry.port } : {}),
    ...(entry.user ? { user: entry.user } : {}),
    ...(entry.identityFile ? { identityFile: entry.identityFile } : {}),
    available: true
  });
}

function normalizeConfigPath(input: string | undefined): string | undefined {
  const text = input?.trim();
  if (!text) return undefined;
  return path.resolve(expandHome(text));
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input.replace(/\$\{env:([^}]+)\}/gi, (_match, name: string) => process.env[name] ?? '');
}

function stripSshConfigComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? undefined : quote ?? char;
    }
    if (char === '#' && !quote) return line.slice(0, index);
  }
  return line;
}
