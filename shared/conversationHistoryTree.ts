import type {
  ConversationOriginLinkRecord,
  SidebarConversationHistoryEntry
} from './protocol';

export interface ConversationHistoryTreeNode {
  entry: SidebarConversationHistoryEntry;
  originLink?: ConversationOriginLinkRecord;
  parentConversationId?: string;
  children: ConversationHistoryTreeNode[];
  latestUpdatedAt: number;
}

/**
 * 将独立的对话条目与来源 Link 组合成只读树投影。
 *
 * 来源 Link 仍然是独立关系数据；这里只在展示/分页边界临时解释它。缺失父项、
 * 自引用以及循环关系都会回落为根节点，避免一条损坏关系隐藏整段历史记录。
 */
export function buildConversationHistoryForest(
  entries: readonly SidebarConversationHistoryEntry[],
  originLinks: readonly ConversationOriginLinkRecord[]
): ConversationHistoryTreeNode[] {
  const entryById = new Map<string, SidebarConversationHistoryEntry>();
  for (const entry of entries) {
    if (entry.id) entryById.set(entry.id, entry);
  }

  const originLinkByConversationId = selectConversationOriginLinks(originLinks);
  const parentByChildId = new Map<string, string>();
  for (const [conversationId, link] of originLinkByConversationId) {
    const parentConversationId = link.sourceConversationId;
    if (!parentConversationId || parentConversationId === conversationId) continue;
    if (!entryById.has(conversationId) || !entryById.has(parentConversationId)) continue;
    parentByChildId.set(conversationId, parentConversationId);
  }

  const cyclicChildIds = new Set<string>();
  for (const conversationId of parentByChildId.keys()) {
    if (parentPathContainsCycle(conversationId, parentByChildId)) cyclicChildIds.add(conversationId);
  }

  const nodeById = new Map<string, ConversationHistoryTreeNode>();
  for (const entry of entryById.values()) {
    const originLink = originLinkByConversationId.get(entry.id);
    nodeById.set(entry.id, {
      entry,
      ...(originLink ? { originLink } : {}),
      children: [],
      latestUpdatedAt: entry.updatedAt ?? 0
    });
  }

  const roots: ConversationHistoryTreeNode[] = [];
  for (const node of nodeById.values()) {
    const conversationId = node.entry.id;
    const parentConversationId = cyclicChildIds.has(conversationId)
      ? undefined
      : parentByChildId.get(conversationId);
    const parent = parentConversationId ? nodeById.get(parentConversationId) : undefined;
    if (!parent || parent === node) {
      roots.push(node);
      continue;
    }
    node.parentConversationId = parentConversationId;
    parent.children.push(node);
  }

  for (const root of roots) updateSubtreeActivityAndSort(root);
  roots.sort(compareConversationHistoryTreeNodes);
  return roots;
}

/** 以先序顺序展开完整树，父条目始终位于其所有后代之前。 */
export function flattenConversationHistoryForest(
  roots: readonly ConversationHistoryTreeNode[]
): ConversationHistoryTreeNode[] {
  const result: ConversationHistoryTreeNode[] = [];
  const append = (node: ConversationHistoryTreeNode): void => {
    result.push(node);
    for (const child of node.children) append(child);
  };
  for (const root of roots) append(root);
  return result;
}

/**
 * 按名义页容量打包根会话树。单棵树绝不跨页；若其自身超过容量，则该页允许超限。
 */
export function packConversationHistoryForestIntoPages(
  forest: readonly ConversationHistoryTreeNode[],
  pageSize: number
): ConversationHistoryTreeNode[][] {
  const normalizedPageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 1;
  const pages: ConversationHistoryTreeNode[][] = [];
  let currentPage: ConversationHistoryTreeNode[] = [];

  const flush = (): void => {
    if (!currentPage.length) return;
    pages.push(currentPage);
    currentPage = [];
  };

  for (const root of forest) {
    const tree = flattenConversationHistoryForest([root]);
    if (currentPage.length && currentPage.length + tree.length > normalizedPageSize) flush();
    currentPage.push(...tree);
    if (currentPage.length >= normalizedPageSize) flush();
  }
  flush();
  return pages;
}

/** 每个对话只选择最早建立的来源 Link，保持父级关系稳定。 */
export function selectConversationOriginLinks(
  originLinks: readonly ConversationOriginLinkRecord[]
): Map<string, ConversationOriginLinkRecord> {
  const result = new Map<string, ConversationOriginLinkRecord>();
  for (const link of originLinks) {
    if (!link.conversationId) continue;
    const existing = result.get(link.conversationId);
    if (!existing || compareOriginLinks(link, existing) < 0) result.set(link.conversationId, link);
  }
  return result;
}

function parentPathContainsCycle(
  conversationId: string,
  parentByChildId: ReadonlyMap<string, string>
): boolean {
  const visited = new Set<string>([conversationId]);
  let current = parentByChildId.get(conversationId);
  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = parentByChildId.get(current);
  }
  return false;
}

function updateSubtreeActivityAndSort(node: ConversationHistoryTreeNode): number {
  let latestUpdatedAt = node.entry.updatedAt ?? 0;
  for (const child of node.children) {
    latestUpdatedAt = Math.max(latestUpdatedAt, updateSubtreeActivityAndSort(child));
  }
  node.latestUpdatedAt = latestUpdatedAt;
  node.children.sort(compareConversationHistoryTreeNodes);
  return latestUpdatedAt;
}

function compareConversationHistoryTreeNodes(
  left: ConversationHistoryTreeNode,
  right: ConversationHistoryTreeNode
): number {
  return right.latestUpdatedAt - left.latestUpdatedAt
    || compareConversationHistoryEntries(left.entry, right.entry);
}

function compareConversationHistoryEntries(
  left: SidebarConversationHistoryEntry,
  right: SidebarConversationHistoryEntry
): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || left.title.localeCompare(right.title, 'zh-CN')
    || left.id.localeCompare(right.id, 'zh-CN');
}

function compareOriginLinks(
  left: ConversationOriginLinkRecord,
  right: ConversationOriginLinkRecord
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
