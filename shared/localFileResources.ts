export const LOCAL_RESOURCE_MAPPINGS_META_NAME = 'limcode-local-resource-mappings';
export const LOCAL_FILE_LINK_DATA_ATTRIBUTE = 'data-limcode-local-file';

export interface WebviewLocalResourceMapping {
  pathPrefix: string;
  resourceBase: string;
  caseSensitive: boolean;
}

const PASSTHROUGH_SCHEME = /^(https?:|data:|blob:|vscode-resource:|vscode-webview-resource:|vscode-webview:)/i;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_URI_PATH = /^\/[a-zA-Z]:\//;

/**
 * 把 Markdown token 中的本地文件来源规范化成使用 `/` 的绝对文件系统路径。
 * markdown-it 会把 Windows 反斜杠编码成 `%5C`，因此必须先 decode 再判断。
 */
export function normalizeLocalFileSource(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || PASSTHROUGH_SCHEME.test(trimmed)) return undefined;

  if (/^file:/i.test(trimmed)) return normalizeFileUrl(trimmed);

  const decoded = safeDecode(trimmed);
  if (/^\\\\/.test(decoded)) return normalizePath(`//${decoded.slice(2)}`);
  // markdown-it 会把裸 UNC 的两个开头反斜杠折叠为一个，并编码成 `%5Cserver%5Cshare`。
  if (/^%5c/i.test(trimmed) && /^\\[^\\/]+[\\/][^\\/]+/.test(decoded)) {
    return normalizePath(`//${decoded.slice(1)}`);
  }
  if (WINDOWS_ABSOLUTE.test(decoded)) return normalizePath(decoded);
  if (decoded.startsWith('/') && !decoded.startsWith('//')) return normalizePath(decoded);
  return undefined;
}

export function toMappedWebviewResourceUri(
  source: string,
  mappings: readonly WebviewLocalResourceMapping[]
): string | undefined {
  const normalized = normalizeLocalFileSource(source);
  if (!normalized) return undefined;

  const mapping = [...mappings]
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length)
    .find((candidate) => localFilePathStartsWith(normalized, candidate));
  if (!mapping) return undefined;

  const relative = normalized.slice(mapping.pathPrefix.length).replace(/^\/+/, '');
  const base = mapping.resourceBase.replace(/\/+$/, '');
  const encoded = encodeRelativeFilePath(relative);
  return encoded ? `${base}/${encoded}` : base;
}

export function encodeRelativeFilePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function localFileSourceToUriPath(source: string): string | undefined {
  const normalized = normalizeLocalFileSource(source);
  if (!normalized) return undefined;
  if (/^[a-zA-Z]:\//.test(normalized)) return `/${normalized}`;
  return normalized;
}

function normalizeFileUrl(source: string): string | undefined {
  try {
    const parsed = new URL(source);
    if (parsed.protocol.toLowerCase() !== 'file:') return undefined;
    const pathname = safeDecode(parsed.pathname).replace(/\\/g, '/');
    if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') {
      return normalizePath(`//${safeDecode(parsed.hostname)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
    }
    return normalizePath(WINDOWS_URI_PATH.test(pathname) ? pathname.slice(1) : pathname || '/');
  } catch {
    const withoutScheme = safeDecode(source.replace(/^file:\/{0,3}/i, ''));
    if (WINDOWS_ABSOLUTE.test(withoutScheme)) return normalizePath(withoutScheme);
    return withoutScheme ? normalizePath(`/${withoutScheme.replace(/^\/+/, '')}`) : undefined;
  }
}

function normalizePath(value: string): string {
  const slashed = value.replace(/\\/g, '/');
  const unc = slashed.startsWith('//');
  const drive = /^[a-zA-Z]:\//.test(slashed) ? `${slashed[0].toUpperCase()}:` : undefined;
  const prefix = unc ? '//' : drive ? `${drive}/` : '/';
  const body = unc
    ? slashed.slice(2)
    : drive
      ? slashed.slice(3)
      : slashed.replace(/^\/+/, '');
  const segments: string[] = [];
  for (const segment of body.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join('/')}`;
}

export function localFilePathStartsWith(path: string, mapping: Pick<WebviewLocalResourceMapping, 'pathPrefix' | 'caseSensitive'>): boolean {
  const left = mapping.caseSensitive ? path : path.toLowerCase();
  const right = mapping.caseSensitive ? mapping.pathPrefix : mapping.pathPrefix.toLowerCase();
  if (!left.startsWith(right)) return false;
  if (right.endsWith('/')) return true;
  return left.length === right.length || left[right.length] === '/';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
