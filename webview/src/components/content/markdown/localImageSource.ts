/**
 * 把 Markdown 里的本地文件路径转换成 Webview 可加载的资源 URI。
 *
 * VS Code Webview 无法直接加载 `file://` 或裸绝对路径，必须转换成
 * `webview.asWebviewUri()` 产出的形式（`https://file+.vscode-resource.vscode-cdn.net/...`），
 * 该来源已包含在 CSP 的 `${webview.cspSource}` 中，因此无需放宽 CSP。
 *
 * 扩展侧通过 `<meta name="limcode-local-resource-base">` 注入基地址，
 * 见 vscode/webview/getWebviewHtml.ts。
 */

// 需与 vscode/webview/getWebviewHtml.ts 中的 LOCAL_RESOURCE_BASE_META_NAME 保持一致。
const RESOURCE_BASE_META = 'limcode-local-resource-base';

/** 已经可以直接加载的来源，无需改写。 */
const PASSTHROUGH_SCHEME = /^(https?:|data:|blob:|vscode-resource:|vscode-webview-resource:|vscode-webview:)/i;

/** Windows 盘符绝对路径，例如 F:\a\b.png 或 F:/a/b.png */
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

let cachedBase: string | null | undefined;

function getResourceBase(): string | null {
  if (cachedBase !== undefined) return cachedBase;

  if (typeof document === 'undefined') {
    cachedBase = null;
    return cachedBase;
  }

  const meta = document.querySelector(`meta[name="${RESOURCE_BASE_META}"]`);
  const content = meta?.getAttribute('content')?.trim();
  cachedBase = content ? content.replace(/\/+$/, '') : null;

  return cachedBase;
}

/**
 * 将文件系统路径编码为 Webview 资源 URI 的 path 部分。
 * 盘符会被小写并把 `:` 编码为 `%3A`，与 VS Code 的 Uri 行为一致。
 */
function encodeFsPath(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, '/').replace(/^\/+/, '');

  return normalized
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment, index) => {
      if (index === 0 && /^[a-zA-Z]:$/.test(segment)) {
        return `${segment[0].toLowerCase()}%3A`;
      }
      return encodeURIComponent(segment);
    })
    .join('/');
}

/** 从 `file://` URL 中取出文件系统路径。 */
function fileUrlToFsPath(source: string): string {
  const withoutScheme = source.replace(/^file:\/{2,}/i, '');
  const decoded = safeDecode(withoutScheme);

  // file:///F:/a.png 去掉 scheme 后是 F:/a.png；POSIX 下需要补回根斜杠。
  return WINDOWS_ABSOLUTE.test(decoded) ? decoded : `/${decoded.replace(/^\/+/, '')}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLocalFileSource(source: string): boolean {
  if (/^file:/i.test(source)) return true;
  if (WINDOWS_ABSOLUTE.test(source)) return true;
  // POSIX 绝对路径；排除 //host 形式的协议相对 URL。
  if (source.startsWith('/') && !source.startsWith('//')) return true;

  return false;
}

/**
 * 转换 Markdown 图片的 src。
 * 非本地路径、或基地址不可用时原样返回。
 */
export function toWebviewImageSrc(source: string): string {
  const trimmed = source.trim();
  if (!trimmed || PASSTHROUGH_SCHEME.test(trimmed)) return source;
  if (!isLocalFileSource(trimmed)) return source;

  const base = getResourceBase();
  if (!base) return source;

  const fsPath = /^file:/i.test(trimmed) ? fileUrlToFsPath(trimmed) : safeDecode(trimmed);

  return `${base}/${encodeFsPath(fsPath)}`;
}
