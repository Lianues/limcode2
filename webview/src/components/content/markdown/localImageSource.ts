import {
  LOCAL_RESOURCE_MAPPINGS_META_NAME,
  toMappedWebviewResourceUri,
  type WebviewLocalResourceMapping
} from '@shared/localFileResources';

/**
 * 扩展侧把每个已授权文件系统根通过 webview.asWebviewUri() 转换后注入 meta。
 * 前端只负责按最长 pathPrefix 匹配并拼接相对路径，不再假设本地 file:/// 与
 * Remote SSH / WSL / Container 使用相同 scheme。
 */
let cachedMappings: WebviewLocalResourceMapping[] | undefined;

function getResourceMappings(): WebviewLocalResourceMapping[] {
  if (cachedMappings !== undefined) return cachedMappings;
  cachedMappings = [];
  if (typeof document === 'undefined') return cachedMappings;

  const meta = document.querySelector(`meta[name="${LOCAL_RESOURCE_MAPPINGS_META_NAME}"]`);
  const content = meta?.getAttribute('content')?.trim();
  if (!content) return cachedMappings;

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return cachedMappings;
    cachedMappings = parsed.filter(isResourceMapping).map((mapping) => ({ ...mapping }));
  } catch (error) {
    console.warn('[LimCode] Failed to parse local resource mappings.', error);
  }
  return cachedMappings;
}

function isResourceMapping(value: unknown): value is WebviewLocalResourceMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mapping = value as Partial<WebviewLocalResourceMapping>;
  return typeof mapping.pathPrefix === 'string'
    && mapping.pathPrefix.length > 0
    && typeof mapping.resourceBase === 'string'
    && mapping.resourceBase.length > 0
    && typeof mapping.caseSensitive === 'boolean';
}

/** 非本地路径或未获得扩展侧资源授权时保持原 src。 */
export function toWebviewImageSrc(source: string): string {
  return toMappedWebviewResourceUri(source, getResourceMappings()) ?? source;
}
