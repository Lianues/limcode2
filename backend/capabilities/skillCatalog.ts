import * as vscode from 'vscode';
import type { SkillDefinitionRecord, SkillSource } from '../../shared/protocol';
import type { SkillCatalogCapability } from './types';
import { resolveDataRootUri } from './vscodeStorage/globalStatus';

const SKILL_ENTRY_FILE = 'SKILL.md';
const LOCAL_SKILLS_SEGMENTS = ['.agents', 'skills'] as const;
const GLOBAL_SKILLS_SEGMENT = 'skills';

/**
 * 技能目录扫描能力实现。
 * 局部技能：<workspaceFolder>/.agents/skills/<slug>/SKILL.md
 * 全局技能：<dataRoot>/skills/<slug>/SKILL.md
 * SKILL.md 采用 YAML frontmatter（name/description）+ markdown 正文，与 Claude Code 一致。
 */
export function createSkillCatalogCapability(context: vscode.ExtensionContext): SkillCatalogCapability {
  let skills: SkillDefinitionRecord[] = [];

  function findByIdOrName(idOrName: string): SkillDefinitionRecord | undefined {
    const key = idOrName.trim();
    if (!key) return undefined;
    return skills.find((skill) => skill.id === key)
      ?? skills.find((skill) => skill.name === key)
      ?? skills.find((skill) => skill.slug === key);
  }

  async function refresh(): Promise<void> {
    const discovered: SkillDefinitionRecord[] = [];
    const seenIds = new Set<string>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = vscode.Uri.joinPath(folder.uri, ...LOCAL_SKILLS_SEGMENTS);
      const items = await scanSkillsRoot(root, 'local', folder.uri.toString());
      appendUnique(discovered, seenIds, items);
    }

    const globalRoot = vscode.Uri.joinPath(resolveDataRootUri(context), GLOBAL_SKILLS_SEGMENT);
    appendUnique(discovered, seenIds, await scanSkillsRoot(globalRoot, 'global'));

    discovered.sort((left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name));
    skills = discovered;
  }

  return {
    list: () => skills,
    get: (idOrName) => findByIdOrName(idOrName),
    async readBody(idOrName) {
      const skill = findByIdOrName(idOrName);
      if (!skill) throw new Error(`未找到技能：${idOrName}`);
      const raw = await readTextFile(vscode.Uri.file(skill.path));
      return stripFrontmatter(raw).trim();
    },
    refresh
  };
}

function appendUnique(target: SkillDefinitionRecord[], seenIds: Set<string>, items: SkillDefinitionRecord[]): void {
  for (const item of items) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    target.push(item);
  }
}

async function scanSkillsRoot(root: vscode.Uri, source: SkillSource, workspaceFolderUri?: string): Promise<SkillDefinitionRecord[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return [];
  }

  const skills: SkillDefinitionRecord[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const slug = name.trim();
    if (!slug) continue;
    const dir = vscode.Uri.joinPath(root, name);
    const entryUri = vscode.Uri.joinPath(dir, SKILL_ENTRY_FILE);
    let raw: string;
    try {
      raw = await readTextFile(entryUri);
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(raw);
    skills.push({
      id: `skill:${source}:${slug}`,
      slug,
      name: frontmatter.name || slug,
      description: frontmatter.description || '',
      source,
      path: entryUri.fsPath,
      dir: dir.fsPath,
      ...(workspaceFolderUri ? { workspaceFolderUri } : {})
    });
  }
  return skills;
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

const FRONTMATTER_PATTERN = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 极简 frontmatter 解析：只取顶层 key: value（name/description），不引入 YAML 依赖。 */
function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) return {};
  const result: SkillFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key !== 'name' && key !== 'description') continue;
    result[key] = stripInlineValue(line.slice(separator + 1));
  }
  return result;
}

function stripInlineValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripFrontmatter(raw: string): string {
  const match = FRONTMATTER_PATTERN.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
