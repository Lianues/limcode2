import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { MainPanel } from './panels/MainPanel';
import { registerSidebarEntryView } from './views/SidebarEntryView';
import { BackendApplication } from '../backend/application/BackendApplication';

let backendApp: BackendApplication | undefined;

export function activate(context: vscode.ExtensionContext): void {
  backendApp = new BackendApplication(context);

  MainPanel.registerSerializer(context, backendApp);
  registerCommands(context, backendApp);
  registerSidebarEntryView(context, backendApp);

  console.log('LimCode (ECS backend) is active.');
}

export function deactivate(): void {
  backendApp?.dispose();
  backendApp = undefined;
}
