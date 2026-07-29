import { createHash } from 'node:crypto';

/**
 * 由已规范化的纯 JSON 数据生成稳定、不依赖时钟精度的 opaque revision。
 *
 * 相同业务快照得到相同 revision；任何字段、数组顺序或 record 内容变化都会推进
 * revision。对象键会递归排序，避免仅因属性插入顺序不同制造假冲突。
 */
export function createStorageRevision(value: unknown): string {
  const canonical = JSON.stringify(canonicalizeJson(value));
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** 用于尚未发布任何快照的资源，允许初始化也走与普通提交相同的 CAS。 */
export function createMissingStorageRevision(resource: string): string {
  return createStorageRevision({ kind: 'storage.missing', resource });
}

function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Storage revision input contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
        throw new Error(`Storage revision input contains an unsupported value at key "${key}".`);
      }
      result[key] = canonicalizeJson(child);
    }
    return result;
  }
  throw new Error(`Storage revision input is not JSON-compatible: ${typeof value}`);
}
