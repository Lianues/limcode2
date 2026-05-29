import * as vscode from 'vscode';
import { LIMCODE_OPENAI_API_KEY_SECRET } from '../../backend/capabilities';
import { MainPanel } from '../panels/MainPanel';
import type { BackendApplication } from '../../backend/application/BackendApplication';

const COMMANDS = {
  openPanel: 'limcode.openPanel',
  configureApiKey: 'limcode.configureApiKey',
  revealGlobalStorage: 'limcode.revealGlobalStorage'
} as const;

export function registerCommands(context: vscode.ExtensionContext, backendApp: BackendApplication): void {
  const openPanelCommand = vscode.commands.registerCommand(COMMANDS.openPanel, () => {
    MainPanel.createOrShow(context.extensionUri, backendApp);
  });

  const configureApiKeyCommand = vscode.commands.registerCommand(COMMANDS.configureApiKey, async () => {
    const value = await vscode.window.showInputBox({
      title: 'LimCode API Key',
      prompt: '输入 OpenAI 兼容接口 API Key（会保存到 VS Code SecretStorage，不会写入仓库）',
      placeHolder: 'sk-...',
      password: true,
      ignoreFocusOut: true
    });

    if (value === undefined) return;
    const key = value.trim();
    if (!key) {
      await context.secrets.delete(LIMCODE_OPENAI_API_KEY_SECRET);
      void vscode.window.showInformationMessage('LimCode API Key 已清除。');
      return;
    }

    await context.secrets.store(LIMCODE_OPENAI_API_KEY_SECRET, key);
    void vscode.window.showInformationMessage('LimCode API Key 已保存到 VS Code SecretStorage。');
  });

  const revealGlobalStorageCommand = vscode.commands.registerCommand(COMMANDS.revealGlobalStorage, async () => {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.commands.executeCommand('revealFileInOS', context.globalStorageUri);
  });

  context.subscriptions.push(openPanelCommand, configureApiKeyCommand, revealGlobalStorageCommand);
}
