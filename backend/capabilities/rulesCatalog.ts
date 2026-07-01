import * as vscode from 'vscode';
import type { RuleFileRecord, RuleKind, RuleScope } from '../../shared/protocol';
import type { RulesCatalogCapability } from './types';
import { resolveDataRootUri } from './vscodeStorage/globalStatus';

const RULE_FILE_NAMES: Record<RuleKind, string> = {
  AGENTS: 'AGENTS.md',
  CLAUDE: 'CLAUDE.md'
};

/** 每个作用域下都读取 AGENTS + CLAUDE 两个规则文件。 */
const RULE_KINDS: readonly RuleKind[] = ['AGENTS', 'CLAUDE'];

/**
 * 规则文件扫描能力实现。
 * 局部规则（project）：<workspaceFolder>/AGENTS.md、<workspaceFolder>/CLAUDE.md
 * 全局规则（global）：<dataRoot>/AGENTS.md、<dataRoot>/CLAUDE.md
 * AGENTS.md 由我们维护（可读写）；CLAUDE.md 仅作兼容只读读取（用户自行修改文件）。
 */
export function createRulesCatalogCapability(context: vscode.ExtensionContext): RulesCatalogCapability {
  let rules: RuleFileRecord[] = [];

  /** 单根场景取第一个 workspace folder；无工作区时返回 undefined（项目规则不可用）。 */
  function projectRootUri(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  function scopeRootUri(scope: RuleScope): vscode.Uri | undefined {
    return scope === 'global' ? resolveDataRootUri(context) : projectRootUri();
  }

  function fileUri(scope: RuleScope, kind: RuleKind): vscode.Uri | undefined {
    const root = scopeRootUri(scope);
    return root ? vscode.Uri.joinPath(root, RULE_FILE_NAMES[kind]) : undefined;
  }

  async function readRule(scope: RuleScope, kind: RuleKind, workspaceFolderUri?: string): Promise<RuleFileRecord | undefined> {
    const uri = fileUri(scope, kind);
    if (!uri) return undefined;
    const read = await readTextFile(uri);
    return {
      id: `rule:${scope}:${kind}`,
      scope,
      kind,
      editable: kind === 'AGENTS',
      path: uri.fsPath,
      exists: read !== undefined,
      content: read ?? '',
      ...(workspaceFolderUri ? { workspaceFolderUri } : {})
    };
  }

  async function refresh(): Promise<void> {
    const discovered: RuleFileRecord[] = [];
    const projectFolderUri = projectRootUri()?.toString();

    for (const scope of ['global', 'project'] as const) {
      for (const kind of RULE_KINDS) {
        const record = await readRule(scope, kind, scope === 'project' ? projectFolderUri : undefined);
        if (record) discovered.push(record);
      }
    }

    rules = discovered;
  }

  return {
    list: () => rules,
    async writeAgents(scope: RuleScope, content: string): Promise<void> {
      const uri = fileUri(scope, 'AGENTS');
      if (!uri) throw new Error(scope === 'project' ? '未打开工作区，无法保存项目规则。' : '无法解析数据根目录。');
      await vscode.workspace.fs.createDirectory(dirnameUri(uri));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    },
    refresh
  };
}

/** 读取文本文件；文件不存在（或不可读）时返回 undefined，供“未创建”占位使用。 */
async function readTextFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

function dirnameUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}
