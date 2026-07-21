import { createMessageId } from '../../shared/protocol';

/**
 * 生成后端领域对象使用的永久稳定 ID。
 *
 * 约束：
 * - 不依赖 ECS Entity；
 * - 输出包含可读前缀；
 * - 后缀复用 shared 的时间+随机短串，便于排序和排查；
 * - prefix 会被规范化，避免把空白或不可读字符带入协议/存储。
 */
export function createStableId(prefix: string): string {
  const normalizedPrefix = normalizeStableIdPrefix(prefix);
  return `${normalizedPrefix}-${createMessageId()}`;
}

export function normalizeStableIdPrefix(prefix: string): string {
  const normalized = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('createStableId prefix cannot be empty.');
  return normalized;
}
