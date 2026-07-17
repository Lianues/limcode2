import * as vscode from 'vscode';
import { MainPanel, type MainPanelOptions } from '../panels/MainPanel';
import type { BackendApplication } from '../../backend/application/BackendApplication';

const COMMANDS = {
  openPanel: 'limcode.openPanel',
  revealGlobalStorage: 'limcode.revealGlobalStorage'
} as const;

export function registerCommands(context: vscode.ExtensionContext, backendApp: BackendApplication): void {
  const openPanelCommand = vscode.commands.registerCommand(COMMANDS.openPanel, (options?: unknown) => {
    MainPanel.createOrShow(context.extensionUri, backendApp, openPanelOptions(options));
  });

  const revealGlobalStorageCommand = vscode.commands.registerCommand(COMMANDS.revealGlobalStorage, async () => {
    const storageRootUri = backendApp.getStorageRootUri();
    await vscode.workspace.fs.createDirectory(storageRootUri);
    await vscode.commands.executeCommand('revealFileInOS', storageRootUri);
  });

  context.subscriptions.push(openPanelCommand, revealGlobalStorageCommand);
}

function openPanelOptions(value: unknown): MainPanelOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const options: MainPanelOptions = {};
  if (typeof record.conversationId === 'string' && record.conversationId.trim()) options.conversationId = record.conversationId.trim();
  if (typeof record.title === 'string' && record.title.trim()) options.title = record.title.trim();
  if (record.kind === 'chat' || record.kind === 'globalSettings' || record.kind === 'workflowSettings' || record.kind === 'agentSettings') options.kind = record.kind;
  if (typeof record.reuse === 'boolean') options.reuse = record.reuse;
  return options;
}
