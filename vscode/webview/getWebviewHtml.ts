import * as fs from 'node:fs';
import * as vscode from 'vscode';

const WEBVIEW_DEV_SERVER_ENV = 'VSCODE_WEBVIEW_DEV_SERVER';

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const webviewDistUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexUri = vscode.Uri.joinPath(webviewDistUri, 'index.html');
  const nonce = getNonce();
  const devServerUrl = getWebviewDevServerUrl();
  const csp = createContentSecurityPolicy(webview, nonce, devServerUrl);

  if (devServerUrl) {
    return getDevServerHtml(devServerUrl, csp, nonce);
  }

  if (!fs.existsSync(indexUri.fsPath)) {
    return getMissingBuildHtml(csp);
  }

  let html = fs.readFileSync(indexUri.fsPath, 'utf8');

  html = html.replace(/<script\s/g, `<script nonce="${nonce}" `);
  html = html.replace(/(src|href)="(.+?)"/g, (_, attr: string, source: string) => {
    if (/^(https?:|data:|vscode-resource:|vscode-webview-resource:)/.test(source)) {
      return `${attr}="${source}"`;
    }

    const normalizedSource = source.replace(/^\.\//, '').replace(/^\//, '');
    const resourceUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDistUri, ...normalizedSource.split('/'))
    );

    return `${attr}="${resourceUri}"`;
  });

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;

  if (html.includes('http-equiv="Content-Security-Policy"')) {
    return html.replace(/<meta http-equiv="Content-Security-Policy" content=".*?">/, cspMeta);
  }

  return html.replace('<head>', `<head>\n    ${cspMeta}`);
}

function createContentSecurityPolicy(
  webview: vscode.Webview,
  nonce: string,
  devServerUrl?: string
): string {
  const devHttpSource = devServerUrl;
  const devWebSocketSource = devServerUrl ? toWebSocketOrigin(devServerUrl) : undefined;
  const devSources = [devHttpSource, devWebSocketSource].filter(Boolean).join(' ');

  return [
    `default-src 'none';`,
    `img-src ${webview.cspSource} https: data:${devHttpSource ? ` ${devHttpSource}` : ''};`,
    `font-src ${webview.cspSource}${devHttpSource ? ` ${devHttpSource}` : ''};`,
    `style-src ${webview.cspSource}${devHttpSource ? ` ${devHttpSource}` : ''} 'unsafe-inline';`,
    `script-src 'nonce-${nonce}'${devHttpSource ? ` ${devHttpSource}` : ''};`,
    devSources ? `connect-src ${webview.cspSource} ${devSources};` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function getWebviewDevServerUrl(): string | undefined {
  const rawUrl = process.env[WEBVIEW_DEV_SERVER_ENV]?.trim();

  if (!rawUrl) {
    return undefined;
  }

  try {
    return new URL(rawUrl).origin;
  } catch {
    console.warn(`Invalid ${WEBVIEW_DEV_SERVER_ENV}: ${rawUrl}`);
    return undefined;
  }
}

function toWebSocketOrigin(httpOrigin: string): string {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.origin;
}

function getDevServerHtml(devServerUrl: string, csp: string, nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vue TS Bridge - HMR</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${devServerUrl}/@vite/client"></script>
  <script type="module" nonce="${nonce}" src="${devServerUrl}/src/main.ts"></script>
</body>
</html>`;
}

function getMissingBuildHtml(csp: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vue TS Bridge</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Webview 资源还没有构建</h2>
  <p>请先在扩展项目根目录执行：</p>
  <p><code>npm install</code></p>
  <p><code>npm run build</code></p>
  <p>然后重新运行扩展或再次打开面板。</p>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}
