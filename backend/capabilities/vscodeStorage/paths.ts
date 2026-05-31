import * as vscode from 'vscode';
import type { RuntimePaths } from '../types';
import {
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  AGENT_MODE_LINKS_ROOT_DIR,
  AGENT_MODES_ROOT_DIR,
  AGENTS_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  INDEX_FILE,
  LLM_SETTINGS_FILE,
  MODE_MODEL_PROFILE_LINKS_ROOT_DIR,
  MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR,
  MODE_TOOL_POLICY_LINKS_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  SETTINGS_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
  TOOL_POLICIES_ROOT_DIR
} from './constants';

export interface VscodeStorageUris {
  agentsRootUri: vscode.Uri;
  agentsIndexUri: vscode.Uri;
  agentModesRootUri: vscode.Uri;
  agentModesIndexUri: vscode.Uri;
  toolPoliciesRootUri: vscode.Uri;
  toolPoliciesIndexUri: vscode.Uri;
  systemPromptsRootUri: vscode.Uri;
  systemPromptsIndexUri: vscode.Uri;
  modelProfilesRootUri: vscode.Uri;
  modelProfilesIndexUri: vscode.Uri;
  conversationsRootUri: vscode.Uri;
  conversationsIndexUri: vscode.Uri;
  linksRootUri: vscode.Uri;
  linksIndexUri: vscode.Uri;
  agentModeLinksRootUri: vscode.Uri;
  agentModeLinksIndexUri: vscode.Uri;
  modeToolPolicyLinksRootUri: vscode.Uri;
  modeToolPolicyLinksIndexUri: vscode.Uri;
  modeSystemPromptLinksRootUri: vscode.Uri;
  modeSystemPromptLinksIndexUri: vscode.Uri;
  modeModelProfileLinksRootUri: vscode.Uri;
  modeModelProfileLinksIndexUri: vscode.Uri;
  settingsRootUri: vscode.Uri;
  llmSettingsUri: vscode.Uri;
}

export function createVscodeStoragePaths(globalStorageUri: vscode.Uri): RuntimePaths & VscodeStorageUris {
  const agentsRootUri = vscode.Uri.joinPath(globalStorageUri, AGENTS_ROOT_DIR);
  const agentsIndexUri = vscode.Uri.joinPath(agentsRootUri, INDEX_FILE);
  const agentModesRootUri = vscode.Uri.joinPath(globalStorageUri, AGENT_MODES_ROOT_DIR);
  const agentModesIndexUri = vscode.Uri.joinPath(agentModesRootUri, INDEX_FILE);
  const toolPoliciesRootUri = vscode.Uri.joinPath(globalStorageUri, TOOL_POLICIES_ROOT_DIR);
  const toolPoliciesIndexUri = vscode.Uri.joinPath(toolPoliciesRootUri, INDEX_FILE);
  const systemPromptsRootUri = vscode.Uri.joinPath(globalStorageUri, SYSTEM_PROMPTS_ROOT_DIR);
  const systemPromptsIndexUri = vscode.Uri.joinPath(systemPromptsRootUri, INDEX_FILE);
  const modelProfilesRootUri = vscode.Uri.joinPath(globalStorageUri, MODEL_PROFILES_ROOT_DIR);
  const modelProfilesIndexUri = vscode.Uri.joinPath(modelProfilesRootUri, INDEX_FILE);
  const conversationsRootUri = vscode.Uri.joinPath(globalStorageUri, CONVERSATIONS_ROOT_DIR);
  const conversationsIndexUri = vscode.Uri.joinPath(conversationsRootUri, INDEX_FILE);
  const linksRootUri = vscode.Uri.joinPath(globalStorageUri, AGENT_CONVERSATION_LINKS_ROOT_DIR);
  const linksIndexUri = vscode.Uri.joinPath(linksRootUri, INDEX_FILE);
  const agentModeLinksRootUri = vscode.Uri.joinPath(globalStorageUri, AGENT_MODE_LINKS_ROOT_DIR);
  const agentModeLinksIndexUri = vscode.Uri.joinPath(agentModeLinksRootUri, INDEX_FILE);
  const modeToolPolicyLinksRootUri = vscode.Uri.joinPath(globalStorageUri, MODE_TOOL_POLICY_LINKS_ROOT_DIR);
  const modeToolPolicyLinksIndexUri = vscode.Uri.joinPath(modeToolPolicyLinksRootUri, INDEX_FILE);
  const modeSystemPromptLinksRootUri = vscode.Uri.joinPath(globalStorageUri, MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR);
  const modeSystemPromptLinksIndexUri = vscode.Uri.joinPath(modeSystemPromptLinksRootUri, INDEX_FILE);
  const modeModelProfileLinksRootUri = vscode.Uri.joinPath(globalStorageUri, MODE_MODEL_PROFILE_LINKS_ROOT_DIR);
  const modeModelProfileLinksIndexUri = vscode.Uri.joinPath(modeModelProfileLinksRootUri, INDEX_FILE);
  const settingsRootUri = vscode.Uri.joinPath(globalStorageUri, SETTINGS_ROOT_DIR);
  const llmSettingsUri = vscode.Uri.joinPath(settingsRootUri, LLM_SETTINGS_FILE);

  return {
    globalStorageUri,
    globalStoragePath: globalStorageUri.fsPath,
    agentsRootUri,
    agentsRootPath: agentsRootUri.fsPath,
    agentsIndexUri,
    agentsIndexPath: agentsIndexUri.fsPath,
    agentModesRootUri,
    agentModesRootPath: agentModesRootUri.fsPath,
    agentModesIndexUri,
    agentModesIndexPath: agentModesIndexUri.fsPath,
    toolPoliciesRootUri,
    toolPoliciesRootPath: toolPoliciesRootUri.fsPath,
    toolPoliciesIndexUri,
    toolPoliciesIndexPath: toolPoliciesIndexUri.fsPath,
    systemPromptsRootUri,
    systemPromptsRootPath: systemPromptsRootUri.fsPath,
    systemPromptsIndexUri,
    systemPromptsIndexPath: systemPromptsIndexUri.fsPath,
    modelProfilesRootUri,
    modelProfilesRootPath: modelProfilesRootUri.fsPath,
    modelProfilesIndexUri,
    modelProfilesIndexPath: modelProfilesIndexUri.fsPath,
    conversationsRootUri,
    conversationsRootPath: conversationsRootUri.fsPath,
    conversationsIndexUri,
    conversationsIndexPath: conversationsIndexUri.fsPath,
    linksRootUri,
    linksRootPath: linksRootUri.fsPath,
    linksIndexUri,
    linksIndexPath: linksIndexUri.fsPath,
    agentModeLinksRootUri,
    agentModeLinksRootPath: agentModeLinksRootUri.fsPath,
    agentModeLinksIndexUri,
    agentModeLinksIndexPath: agentModeLinksIndexUri.fsPath,
    modeToolPolicyLinksRootUri,
    modeToolPolicyLinksRootPath: modeToolPolicyLinksRootUri.fsPath,
    modeToolPolicyLinksIndexUri,
    modeToolPolicyLinksIndexPath: modeToolPolicyLinksIndexUri.fsPath,
    modeSystemPromptLinksRootUri,
    modeSystemPromptLinksRootPath: modeSystemPromptLinksRootUri.fsPath,
    modeSystemPromptLinksIndexUri,
    modeSystemPromptLinksIndexPath: modeSystemPromptLinksIndexUri.fsPath,
    modeModelProfileLinksRootUri,
    modeModelProfileLinksRootPath: modeModelProfileLinksRootUri.fsPath,
    modeModelProfileLinksIndexUri,
    modeModelProfileLinksIndexPath: modeModelProfileLinksIndexUri.fsPath,
    settingsRootUri,
    settingsRootPath: settingsRootUri.fsPath,
    llmSettingsUri,
    llmSettingsPath: llmSettingsUri.fsPath
  };
}

export async function ensureStorageRoots(...roots: vscode.Uri[]): Promise<void> {
  await Promise.all(roots.map((root) => vscode.workspace.fs.createDirectory(root)));
}
