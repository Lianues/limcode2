const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

class MockUri {
  constructor(scheme, authority, uriPath) {
    this.scheme = scheme;
    this.authority = authority || '';
    this.path = normalizeUriPath(uriPath);
    this.fsPath = this.scheme === 'file'
      ? this.authority
        ? `//${this.authority}${this.path}`
        : /^\/[a-zA-Z]:\//.test(this.path)
          ? this.path.slice(1)
          : this.path
      : this.path;
  }

  static file(fsPath) {
    const normalized = String(fsPath).replace(/\\/g, '/');
    if (normalized.startsWith('//')) {
      const [authority, ...segments] = normalized.slice(2).split('/');
      return new MockUri('file', authority, `/${segments.join('/')}`);
    }
    const uriPath = /^[a-zA-Z]:\//.test(normalized) ? `/${normalized}` : normalized;
    return new MockUri('file', '', uriPath);
  }

  static from(value) {
    return new MockUri(value.scheme, value.authority, value.path);
  }

  static joinPath(base, ...segments) {
    return new MockUri(base.scheme, base.authority, [base.path.replace(/\/$/, ''), ...segments].join('/'));
  }

  toString() {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

function normalizeUriPath(value) {
  const slashed = String(value || '/').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return slashed.startsWith('/') ? slashed : `/${slashed}`;
}

const remoteAuthority = 'ssh-remote+example';
const remoteWorkspace = MockUri.from({
  scheme: 'vscode-remote',
  authority: remoteAuthority,
  path: process.platform === 'win32' ? '/C:/workspace/project' : '/workspace/project'
});
const vscodeMock = {
  Uri: MockUri,
  workspace: { workspaceFolders: [{ uri: remoteWorkspace }] }
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const {
  getWebviewHtml,
  getWebviewLocalResourceRoots,
  getWebviewStaticResourceRoots,
  resolveLocalFileSourceUri
} = require('../dist/extension/vscode/webview/getWebviewHtml.js');
Module._load = originalLoad;

const extensionUri = MockUri.from({
  scheme: 'vscode-remote',
  authority: remoteAuthority,
  path: '/home/user/.vscode/extensions/limcode'
});

test('设置页静态资源权限不包含整盘或远程根', () => {
  const roots = getWebviewStaticResourceRoots(extensionUri);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].toString(), 'vscode-remote://ssh-remote+example/home/user/.vscode/extensions/limcode/dist/webview');
});

test('Remote 工作区外绝对路径使用同 scheme/authority 的资源根和打开 URI', () => {
  const roots = getWebviewLocalResourceRoots(extensionUri);
  const source = process.platform === 'win32' ? 'C:/outside/shot.png' : '/tmp/shot.png';
  const resolved = resolveLocalFileSourceUri(source, extensionUri);

  assert.ok(roots.some((uri) => uri.scheme === 'vscode-remote' && uri.authority === remoteAuthority));
  assert.equal(roots.some((uri) => uri.scheme === 'file'), false);
  assert.equal(resolved?.scheme, 'vscode-remote');
  assert.equal(resolved?.authority, remoteAuthority);
  assert.equal(resolved?.path, process.platform === 'win32' ? '/C:/outside/shot.png' : '/tmp/shot.png');
});

test('UNC workspace 使用 authority 对应的授权根并可解析 markdown-it 编码路径', () => {
  const previousFolders = vscodeMock.workspace.workspaceFolders;
  const uncWorkspace = MockUri.from({ scheme: 'file', authority: 'server', path: '/share/project' });
  vscodeMock.workspace.workspaceFolders = [{ uri: uncWorkspace }];
  try {
    const localExtension = MockUri.file(path.resolve('extension'));
    const roots = getWebviewLocalResourceRoots(localExtension);
    const resolved = resolveLocalFileSourceUri('%5Cserver%5Cshare%5Cproject%5Cassets%5Ca.png', localExtension);
    assert.ok(roots.some((uri) => uri.scheme === 'file' && uri.authority === 'server'));
    assert.equal(resolved?.scheme, 'file');
    assert.equal(resolved?.authority, 'server');
    assert.equal(resolved?.path, '/share/project/assets/a.png');
  } finally {
    vscodeMock.workspace.workspaceFolders = previousFolders;
  }
});

test('仅启用本地 Markdown 资源的页面注入共享 mappings meta', () => {
  const previousDevServer = process.env.VSCODE_WEBVIEW_DEV_SERVER;
  process.env.VSCODE_WEBVIEW_DEV_SERVER = 'http://127.0.0.1:31819';
  try {
    const webview = {
      cspSource: 'https://webview.test',
      asWebviewUri(uri) {
        return { toString: () => `https://resource.test/${encodeURIComponent(uri.scheme)}/${encodeURIComponent(uri.authority)}${uri.path}` };
      }
    };
    const enabled = getWebviewHtml(webview, extensionUri, { enableLocalFileResources: true });
    const disabled = getWebviewHtml(webview, extensionUri, { enableLocalFileResources: false });
    assert.match(enabled, /name="limcode-local-resource-mappings"/);
    assert.match(enabled, /vscode-remote/);
    assert.doesNotMatch(disabled, /limcode-local-resource-mappings/);
  } finally {
    if (previousDevServer === undefined) delete process.env.VSCODE_WEBVIEW_DEV_SERVER;
    else process.env.VSCODE_WEBVIEW_DEV_SERVER = previousDevServer;
  }
});
