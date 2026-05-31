import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import type { BackendApplication } from '../../backend/application/BackendApplication';

const COMMANDS = {
  openPanel: 'limcode.openPanel',
  revealGlobalStorage: 'limcode.revealGlobalStorage'
} as const;

export function registerCommands(context: vscode.ExtensionContext, backendApp: BackendApplication): void {
  const openPanelCommand = vscode.commands.registerCommand(COMMANDS.openPanel, () => {
    MainPanel.createOrShow(context.extensionUri, backendApp);
  });

  const revealGlobalStorageCommand = vscode.commands.registerCommand(COMMANDS.revealGlobalStorage, async () => {
    const storageRootUri = backendApp.getStorageRootUri();
    await vscode.workspace.fs.createDirectory(storageRootUri);
    await vscode.commands.executeCommand('revealFileInOS', storageRootUri);
  });

  context.subscriptions.push(openPanelCommand, revealGlobalStorageCommand);
}
