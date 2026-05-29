import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import type { BackendApplication } from '../../backend/application/BackendApplication';

const COMMANDS = {
  openPanel: 'vscode-vue-ts-bridge-starter.openPanel'
} as const;

export function registerCommands(context: vscode.ExtensionContext, backendApp: BackendApplication): void {
  const openPanelCommand = vscode.commands.registerCommand(COMMANDS.openPanel, () => {
    MainPanel.createOrShow(context.extensionUri, backendApp);
  });

  context.subscriptions.push(openPanelCommand);
}
