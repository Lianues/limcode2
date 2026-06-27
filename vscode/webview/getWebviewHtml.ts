import * as fs from 'node:fs';
import * as vscode from 'vscode';

const WEBVIEW_DEV_SERVER_ENV = 'VSCODE_WEBVIEW_DEV_SERVER';

export interface WebviewHtmlOptions {
  htmlFileName?: string;
  devEntry?: string;
  title?: string;
  rootId?: string;
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, options: WebviewHtmlOptions = {}): string {
  const htmlFileName = options.htmlFileName ?? 'index.html';
  const devEntry = options.devEntry ?? '/src/main.ts';
  const title = options.title ?? 'LimCode';
  const rootId = options.rootId ?? 'app';
  const webviewDistUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexUri = vscode.Uri.joinPath(webviewDistUri, htmlFileName);
  const nonce = getNonce();
  const devServerUrl = getWebviewDevServerUrl();
  const csp = createContentSecurityPolicy(webview, nonce, devServerUrl);

  if (devServerUrl) {
    return getDevServerHtml(devServerUrl, csp, nonce, { title, devEntry, rootId });
  }

  if (!fs.existsSync(indexUri.fsPath)) {
    return getMissingBuildHtml(csp);
  }

  let html = fs.readFileSync(indexUri.fsPath, 'utf8');

  html = html.replace(/<script\s/g, `<script nonce="${nonce}" `);
  html = html.replace(/<link\s+([^>]*rel="modulepreload"[^>]*)>/g, `<link nonce="${nonce}" $1>`);
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

  html = injectLoadingTransition(html, { title, rootId });

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
  const devHttpSources = devServerUrl ? getLoopbackHttpOrigins(devServerUrl) : [];
  const devConnectSources = [...devHttpSources, ...devHttpSources.map(toWebSocketOrigin)];
  const devHttpSourceList = devHttpSources.length > 0 ? ` ${devHttpSources.join(' ')}` : '';
  const devConnectSourceList = devConnectSources.join(' ');

  return [
    `default-src 'none';`,
    `img-src ${webview.cspSource} https: data:${devHttpSourceList};`,
    `media-src ${webview.cspSource} data:${devHttpSourceList};`,
    `font-src ${webview.cspSource}${devHttpSourceList};`,
    `style-src ${webview.cspSource}${devHttpSourceList} 'unsafe-inline';`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}${devHttpSourceList};`,
    devConnectSourceList ? `connect-src ${webview.cspSource} ${devConnectSourceList};` : ''
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

function getLoopbackHttpOrigins(origin: string): string[] {
  const url = new URL(origin);
  const origins = new Set<string>([url.origin]);

  if (isLoopbackHost(url.hostname)) {
    const port = url.port ? `:${url.port}` : '';
    origins.add(`${url.protocol}//localhost${port}`);
    origins.add(`${url.protocol}//127.0.0.1${port}`);
  }

  return [...origins];
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function toWebSocketOrigin(httpOrigin: string): string {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.origin;
}

function getDevServerHtml(
  devServerUrl: string,
  csp: string,
  nonce: string,
  options: { title: string; devEntry: string; rootId: string }
): string {
  const devEntry = options.devEntry.startsWith('/') ? options.devEntry : `/${options.devEntry}`;
  const loadingCopy = getLoadingCopy(options);
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)}</title>
${createLoadingTransitionStyle()}
</head>
<body>
  <div id="${escapeHtml(options.rootId)}">${createLoadingTransitionMarkup(loadingCopy)}</div>
  <script type="module" nonce="${nonce}" src="${devServerUrl}/@vite/client"></script>
  <script type="module" nonce="${nonce}" src="${devServerUrl}${devEntry}"></script>
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
  <title>LimCode</title>
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

interface LoadingTransitionOptions {
  title: string;
  rootId: string;
}

interface LoadingCopy {
  title: string;
  description: string;
}

function injectLoadingTransition(html: string, options: LoadingTransitionOptions): string {
  const rootPattern = new RegExp(`<div\\s+id=["']${escapeRegExp(options.rootId)}["']\\s*>\\s*</div>`, 'i');
  if (!rootPattern.test(html)) return html;

  const loadingCopy = getLoadingCopy(options);
  const withStyle = html.includes('limcode-loading-shell')
    ? html
    : html.replace('</head>', `${createLoadingTransitionStyle()}\n</head>`);
  return withStyle.replace(
    rootPattern,
    `<div id="${escapeHtml(options.rootId)}">${createLoadingTransitionMarkup(loadingCopy)}</div>`
  );
}

function getLoadingCopy(options: LoadingTransitionOptions): LoadingCopy {
  if (options.rootId === 'sidebar-app') {
    return {
      title: '正在打开对话侧边栏',
      description: '正在同步对话历史、项目范围和打开状态。'
    };
  }

  if (options.title.includes('设置')) {
    return {
      title: '正在打开 LimCode 设置',
      description: '正在读取模型、工具和数据目录配置。'
    };
  }

  return {
    title: '正在打开对话标签页',
    description: '正在准备消息列表、对话状态和运行记录。'
  };
}

function createLoadingTransitionMarkup(copy: LoadingCopy): string {
  return /* html */ `
    <main class="limcode-loading-shell" role="status" aria-live="polite">
      <section class="limcode-loading-card" aria-label="${escapeHtml(copy.title)}">
        <div class="limcode-loading-mark" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div class="limcode-loading-copy">
          <div class="limcode-loading-eyebrow">LimCode</div>
          <h1>${escapeHtml(copy.title)}</h1>
          <p>${escapeHtml(copy.description)}</p>
          <div class="limcode-loading-progress" aria-hidden="true"><span></span></div>
        </div>
      </section>
    </main>`;
}

function createLoadingTransitionStyle(): string {
  return /* html */ `  <style>
    html,
    body {
      min-height: 100%;
      color: var(--vscode-foreground, #d4d4d4);
      background: var(--vscode-editor-background, var(--vscode-sideBar-background, #1e1e1e));
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    }

    .limcode-loading-shell {
      min-height: calc(100vh - 16px);
      display: grid;
      place-items: center;
      padding: 20px;
      box-sizing: border-box;
      color: var(--vscode-foreground, #d4d4d4);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-foreground, #d4d4d4) 4%, transparent), transparent 42%),
        var(--vscode-editor-background, var(--vscode-sideBar-background, #1e1e1e));
    }

    .limcode-loading-card {
      width: min(360px, 100%);
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      opacity: 0;
      transform: translateY(5px);
      animation: limcode-loading-card-in 0.22s ease-out forwards;
    }

    .limcode-loading-mark {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
      border-radius: 6px;
      color: var(--vscode-foreground, #d4d4d4);
      background: color-mix(in srgb, var(--vscode-foreground, #d4d4d4) 6%, transparent);
    }

    .limcode-loading-mark span {
      width: 3px;
      height: 10px;
      border-radius: 2px;
      background: currentColor;
      opacity: 0.38;
      animation: limcode-loading-bar 0.86s ease-in-out infinite;
    }

    .limcode-loading-mark span:nth-child(2) { animation-delay: 0.12s; }
    .limcode-loading-mark span:nth-child(3) { animation-delay: 0.24s; }

    .limcode-loading-copy {
      min-width: 0;
    }

    .limcode-loading-eyebrow {
      margin-bottom: 2px;
      color: var(--vscode-descriptionForeground, currentColor);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .limcode-loading-copy h1 {
      margin: 0;
      font-size: 14px;
      line-height: 1.35;
      font-weight: 650;
    }

    .limcode-loading-copy p {
      margin: 4px 0 0;
      color: var(--vscode-descriptionForeground, currentColor);
      font-size: 12px;
      line-height: 1.45;
    }

    .limcode-loading-progress {
      position: relative;
      height: 2px;
      margin-top: 12px;
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-foreground, #d4d4d4) 12%, transparent);
    }

    .limcode-loading-progress span {
      position: absolute;
      inset: 0 auto 0 0;
      width: 38%;
      background: color-mix(in srgb, var(--vscode-foreground, #d4d4d4) 64%, transparent);
      animation: limcode-loading-progress 1.16s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }

    #sidebar-app .limcode-loading-shell {
      min-height: calc(100vh - 16px);
      place-items: start stretch;
      padding: 16px 12px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
    }

    #sidebar-app .limcode-loading-card {
      width: 100%;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: 10px;
    }

    @keyframes limcode-loading-card-in {
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes limcode-loading-bar {
      0%, 100% { transform: scaleY(0.55); opacity: 0.34; }
      50% { transform: scaleY(1.45); opacity: 0.9; }
    }

    @keyframes limcode-loading-progress {
      0% { transform: translateX(-110%); }
      100% { transform: translateX(270%); }
    }

    @media (prefers-reduced-motion: reduce) {
      .limcode-loading-card,
      .limcode-loading-mark span,
      .limcode-loading-progress span {
        animation: none;
      }
      .limcode-loading-card { opacity: 1; transform: none; }
    }
  </style>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
