import * as vscode from 'vscode';
import type { RuntimePaths } from '../types';
import {
  AGENTS_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  INDEX_FILE,
  LINKS_ROOT_DIR,
  GLOBAL_SETTINGS_FILE,
  LLM_SETTINGS_FILE,
  SETTINGS_ROOT_DIR
} from './constants';

export interface VscodeStorageUris {
  agentsRootUri: vscode.Uri;
  agentsIndexUri: vscode.Uri;
  conversationsRootUri: vscode.Uri;
  conversationsIndexUri: vscode.Uri;
  linksRootUri: vscode.Uri;
  linksIndexUri: vscode.Uri;
  settingsRootUri: vscode.Uri;
  globalSettingsUri: vscode.Uri;
  llmSettingsUri: vscode.Uri;
}

export function createVscodeStoragePaths(globalStorageUri: vscode.Uri): RuntimePaths & VscodeStorageUris {
  const agentsRootUri = vscode.Uri.joinPath(globalStorageUri, AGENTS_ROOT_DIR);
  const agentsIndexUri = vscode.Uri.joinPath(agentsRootUri, INDEX_FILE);
  const conversationsRootUri = vscode.Uri.joinPath(globalStorageUri, CONVERSATIONS_ROOT_DIR);
  const conversationsIndexUri = vscode.Uri.joinPath(conversationsRootUri, INDEX_FILE);
  const linksRootUri = vscode.Uri.joinPath(globalStorageUri, LINKS_ROOT_DIR);
  const linksIndexUri = vscode.Uri.joinPath(linksRootUri, INDEX_FILE);
  const settingsRootUri = vscode.Uri.joinPath(globalStorageUri, SETTINGS_ROOT_DIR);
  const globalSettingsUri = vscode.Uri.joinPath(settingsRootUri, GLOBAL_SETTINGS_FILE);
  const llmSettingsUri = vscode.Uri.joinPath(settingsRootUri, LLM_SETTINGS_FILE);

  return {
    globalStorageUri,
    globalStoragePath: globalStorageUri.fsPath,
    agentsRootUri,
    agentsRootPath: agentsRootUri.fsPath,
    agentsIndexUri,
    agentsIndexPath: agentsIndexUri.fsPath,
    conversationsRootUri,
    conversationsRootPath: conversationsRootUri.fsPath,
    conversationsIndexUri,
    conversationsIndexPath: conversationsIndexUri.fsPath,
    linksRootUri,
    linksRootPath: linksRootUri.fsPath,
    linksIndexUri,
    linksIndexPath: linksIndexUri.fsPath,
    settingsRootUri,
    settingsRootPath: settingsRootUri.fsPath,
    globalSettingsUri,
    globalSettingsPath: globalSettingsUri.fsPath,
    llmSettingsUri,
    llmSettingsPath: llmSettingsUri.fsPath
  };
}

export async function ensureStorageRoots(...roots: vscode.Uri[]): Promise<void> {
  await Promise.all(roots.map((root) => vscode.workspace.fs.createDirectory(root)));
}
