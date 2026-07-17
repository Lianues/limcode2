<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconAdjustmentsAlt, IconChevronRight, IconEdit, IconListDetails, IconMessage, IconPlayerStop, IconRobot, IconSettings, IconTrash } from '@tabler/icons-vue';
import type {
  ConversationHistoryPageInfo,
  ConversationHistoryPageRecord,
  ConversationOriginLinkRecord,
  OpenConversationPanelRecord
} from '@shared/protocol';
import { displayConversationTitle as formatConversationTitle } from '@shared/conversationTitle';
import {
  buildConversationHistoryForest,
  flattenConversationHistoryForest,
  selectConversationOriginLinks,
  type ConversationHistoryTreeNode
} from '@shared/conversationHistoryTree';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import { onSidebarMessage, postSidebarMessage } from './sidebarHost';
import {
  SIDEBAR_MESSAGE,
  type ConversationHistoryScope,
  type ProjectFolderCandidateRecord,
  type SidebarHistoryScopeKind,
  type SidebarConversationHistoryEntry
} from './types';

type SidebarView = 'history' | 'settings' | 'projectPicker';
interface ScopeOption {
  key: string;
  label: string;
  description?: string;
  scopeKind: SidebarHistoryScopeKind;
  projectFolderUri?: string;
}

interface VisibleHistoryTreeNode {
  entry: SidebarConversationHistoryEntry;
  originLink?: ConversationOriginLinkRecord;
  parentConversationId?: string;
  depth: number;
  visualDepth: number;
  childCount: number;
  hasChildren: boolean;
  expanded: boolean;
}

const PAGE_SIZE = 50;
const MAX_VISUAL_TREE_DEPTH = 8;
const SCOPE_PAGE_SIZE = 3;
const view = ref<SidebarView>('history');
const entries = ref<SidebarConversationHistoryEntry[]>([]);
const originLinks = ref<ConversationOriginLinkRecord[]>([]);
const expandedConversationIds = ref<Set<string>>(new Set());
const projectFolders = ref<ProjectFolderCandidateRecord[]>([]);
const activeScopeKind = ref<SidebarHistoryScopeKind>('currentProject');
const activeProjectFolderUri = ref<string | undefined>();
const currentProjectScope = ref<ConversationHistoryScope>({ kind: 'unbound' });
const openConversations = ref<OpenConversationPanelRecord[]>([]);
const pageInfo = ref<ConversationHistoryPageInfo>();
const scopePageIndex = ref(0);
const renameTarget = ref<SidebarConversationHistoryEntry>();
const deleteTarget = ref<SidebarConversationHistoryEntry>();
const abortTarget = ref<SidebarConversationHistoryEntry>();
const historyList = ref<HTMLElement | null>(null);
const historyForest = computed(() => buildConversationHistoryForest(entries.value, originLinks.value));
const originLinkByConversationId = computed(() => selectConversationOriginLinks(originLinks.value));
const visibleHistoryNodes = computed(() => flattenVisibleHistoryNodes(historyForest.value, expandedConversationIds.value));
const historyScrollbarRefreshKey = computed(() => `${entries.value.length}:${visibleHistoryNodes.value.length}`);
const historyCountText = computed(() => {
  const total = pageInfo.value?.total ?? entries.value.length;
  const page = pageInfo.value ? `第 ${pageInfo.value.pageIndex + 1} 页` : '当前页';
  return `${total} 个对话 · ${page}`;
});
const currentScopeLabel = computed(() => currentProjectScope.value.kind === 'unbound' ? '未绑定' : '当前项目');
const activeScopeKey = computed(() => scopeOptionKey(activeScopeKind.value, activeProjectFolderUri.value));
const scopeOptions = computed<ScopeOption[]>(() => {
  const options: ScopeOption[] = [
    { key: 'currentProject', label: currentScopeLabel.value, scopeKind: 'currentProject' },
    { key: 'all', label: '全部', scopeKind: 'all' },
    { key: 'unbound', label: '未绑定', scopeKind: 'unbound' }
  ];

  for (const folder of projectFolders.value) {
    const path = displayProjectUri(folder.uri);
    options.push({
      key: scopeOptionKey('project', folder.uri),
      label: folder.name || path,
      description: middleEllipsis(path, 48),
      scopeKind: 'project',
      projectFolderUri: folder.uri
    });
  }

  return options;
});
const pagedScopeOptions = computed(() => {
  const pages: ScopeOption[][] = [];
  for (let index = 0; index < scopeOptions.value.length; index += SCOPE_PAGE_SIZE) {
    pages.push(scopeOptions.value.slice(index, index + SCOPE_PAGE_SIZE));
  }
  return pages;
});
const scopePageCount = computed(() => Math.max(1, pagedScopeOptions.value.length));
const safeScopePageIndex = computed(() => Math.min(scopePageIndex.value, scopePageCount.value - 1));
const visibleScopeOptions = computed(() => {
  const safeIndex = safeScopePageIndex.value;
  return scopeOptions.value.slice(safeIndex * SCOPE_PAGE_SIZE, (safeIndex + 1) * SCOPE_PAGE_SIZE);
});
const activeVisibleScopeIndex = computed(() => visibleScopeOptions.value.findIndex((option) => option.key === activeScopeKey.value));
const scopeTrackStyle = computed(() => ({
  transform: `translateX(-${safeScopePageIndex.value * 100}%)`
}));
const scopeIndicatorStyle = computed(() => {
  const index = activeVisibleScopeIndex.value;
  return {
    left: index >= 0 ? `calc(${(100 / SCOPE_PAGE_SIZE) * index}% + 8px)` : '8px',
    width: `calc(${100 / SCOPE_PAGE_SIZE}% - 16px)`,
    opacity: index >= 0 ? '1' : '0'
  };
});
const canPreviousScopePage = computed(() => safeScopePageIndex.value > 0);
const canNextScopePage = computed(() => safeScopePageIndex.value + 1 < scopePageCount.value);
const isRenameDialogOpen = computed(() => !!renameTarget.value);
const isDeleteDialogOpen = computed(() => !!deleteTarget.value);
const isAbortDialogOpen = computed(() => !!abortTarget.value);
const renameInitialTitle = computed(() => renameTarget.value?.title ?? '');
const renameDialogDescription = computed(() => {
  const title = displayConversationTitle(renameTarget.value);
  return title ? `为「${middleEllipsis(title, 48)}」输入新的对话标题。` : '输入新的对话标题。';
});
const deleteDialogDescriptionHtml = computed(() => {
  const title = displayConversationTitle(deleteTarget.value);
  const target = title ? `「${escapeHtml(middleEllipsis(title, 48))}」` : '这个对话';
  return `将删除${target}以及关联消息、工具记录和运行记录，此操作<strong>无法撤销</strong>。`;
});
const abortDialogDescriptionHtml = computed(() => {
  const title = displayConversationTitle(abortTarget.value);
  const target = title ? `「${escapeHtml(middleEllipsis(title, 48))}」` : '这个对话';
  return `确定终止${target}的后台任务吗？只终止当前后台运行任务，<strong>不会删除对话记录</strong>。`;
});
const deleteConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];
const abortConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '终止' }
];

let disposeMessages: (() => void) | undefined;
let currentHistoryPageIdentity = '';
let autoExpandedActiveConversationId: string | undefined;

onMounted(() => {
  disposeMessages = onSidebarMessage((message) => {
    if (message.type !== SIDEBAR_MESSAGE.state) return;
    const nextScopeKind = message.activeScopeKind ?? activeScopeKind.value;
    const nextPageIdentity = historyPageIdentity(message.history);
    if (nextPageIdentity !== currentHistoryPageIdentity) {
      currentHistoryPageIdentity = nextPageIdentity;
      autoExpandedActiveConversationId = undefined;
    }
    entries.value = Array.isArray(message.history?.entries) ? message.history.entries : [];
    originLinks.value = Array.isArray(message.history?.originLinks) ? message.history.originLinks : [];
    pageInfo.value = message.history?.pageInfo;
    activeScopeKind.value = nextScopeKind;
    if (message.activeProjectFolderUri !== undefined) activeProjectFolderUri.value = message.activeProjectFolderUri;
    else if (nextScopeKind !== 'project') activeProjectFolderUri.value = undefined;
    currentProjectScope.value = message.currentProjectScope ?? currentProjectScope.value;
    projectFolders.value = Array.isArray(message.projectFolders) ? message.projectFolders : [];
    openConversations.value = Array.isArray(message.openConversations) ? message.openConversations : [];
    ensureActiveScopeVisible();
    ensureActiveConversationAncestorsExpanded();
  });
  postSidebarMessage({ type: SIDEBAR_MESSAGE.ready });
});

onBeforeUnmount(() => {
  disposeMessages?.();
});

function setView(next: SidebarView): void {
  view.value = next;
}

function openConversation(entry: SidebarConversationHistoryEntry): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openConversation, conversationId: entry.id, title: displayConversationTitle(entry) });
}

function requestHistoryPage(
  scopeKind: SidebarHistoryScopeKind = activeScopeKind.value,
  cursor?: string,
  projectFolderUri = activeProjectFolderUri.value
): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.historyPageGet, scopeKind, projectFolderUri, cursor, limit: PAGE_SIZE });
}

function switchScope(option: ScopeOption): void {
  activeScopeKind.value = option.scopeKind;
  activeProjectFolderUri.value = option.projectFolderUri;
  requestHistoryPage(option.scopeKind, undefined, option.projectFolderUri);
}

function nextPage(): void {
  if (!pageInfo.value?.nextCursor) return;
  requestHistoryPage(activeScopeKind.value, pageInfo.value.nextCursor, activeProjectFolderUri.value);
}

function previousPage(): void {
  if (!pageInfo.value?.previousCursor) return;
  requestHistoryPage(activeScopeKind.value, pageInfo.value.previousCursor, activeProjectFolderUri.value);
}

function nextScopePage(): void {
  if (!canNextScopePage.value) return;
  scopePageIndex.value += 1;
}

function previousScopePage(): void {
  if (!canPreviousScopePage.value) return;
  scopePageIndex.value -= 1;
}

function startNewConversation(): void {
  if (projectFolders.value.length > 1) {
    setView('projectPicker');
    return;
  }
  createNewConversation();
}

function createNewConversation(projectFolderUri?: string): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.newConversation, ...(projectFolderUri ? { projectFolderUri } : {}) });
  setView('history');
}

function openGlobalSettings(): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openGlobalSettings });
}

function openWorkflowSettings(): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openWorkflowSettings });
}

function openAgentSettings(): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openAgentSettings });
}

function renameConversation(entry: SidebarConversationHistoryEntry): void {
  renameTarget.value = entry;
}

function confirmRenameConversation(title: string): void {
  const target = renameTarget.value;
  renameTarget.value = undefined;
  const nextTitle = title.trim();
  if (!target || !nextTitle) return;
  if (nextTitle === target.title.trim()) return;
  postSidebarMessage({ type: SIDEBAR_MESSAGE.renameConversation, conversationId: target.id, title: nextTitle });
}

function closeRenameDialog(): void {
  renameTarget.value = undefined;
}

function deleteConversation(entry: SidebarConversationHistoryEntry): void {
  deleteTarget.value = entry;
}

function confirmDeleteConversation(): void {
  const target = deleteTarget.value;
  deleteTarget.value = undefined;
  if (!target) return;
  postSidebarMessage({ type: SIDEBAR_MESSAGE.deleteConversation, conversationId: target.id });
}

function closeDeleteDialog(): void {
  deleteTarget.value = undefined;
}

function abortConversation(entry: SidebarConversationHistoryEntry): void {
  abortTarget.value = entry;
}

function confirmAbortConversation(): void {
  const target = abortTarget.value;
  abortTarget.value = undefined;
  if (!target) return;
  postSidebarMessage({ type: SIDEBAR_MESSAGE.abortConversation, conversationId: target.id });
}

function closeAbortDialog(): void {
  abortTarget.value = undefined;
}

function toggleHistoryNode(node: VisibleHistoryTreeNode): void {
  if (!node.hasChildren) return;
  const next = new Set(expandedConversationIds.value);
  if (next.has(node.entry.id)) next.delete(node.entry.id);
  else next.add(node.entry.id);
  expandedConversationIds.value = next;
}

function onHistoryItemKeydown(event: KeyboardEvent, node: VisibleHistoryTreeNode): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openConversation(node.entry);
    return;
  }
  if (event.key === 'ArrowRight' && node.hasChildren && !node.expanded) {
    event.preventDefault();
    toggleHistoryNode(node);
    return;
  }
  if (event.key === 'ArrowLeft' && node.hasChildren && node.expanded) {
    event.preventDefault();
    toggleHistoryNode(node);
  }
}

function statusClass(entry: SidebarConversationHistoryEntry): string {
  if (entry.isRunning) return 'status-running';
  if (entry.status === 'streaming') return 'status-streaming';
  if (entry.status === 'complete') return 'status-complete';
  if (entry.status === 'error') return 'status-error';
  return 'status-empty';
}

function statusText(entry: SidebarConversationHistoryEntry): string {
  if (entry.isRunning) return `后台任务：${entry.runStatusLabel || '执行中'}`;
  if (entry.status === 'streaming') return '正在响应';
  if (entry.status === 'complete') return '已完成';
  if (entry.status === 'error') return '出现错误';
  return '暂无消息';
}

function historyMeta(entry: SidebarConversationHistoryEntry): string {
  const project = activeScopeKind.value === 'all' && entry.projectName ? `${entry.projectName} · ` : '';
  return `${project}${entry.agentName || '默认 Agent'} · ${entry.messageCount || 0} 条消息 · ${formatTime(entry.updatedAt)}`;
}

function originBadgeText(entry: SidebarConversationHistoryEntry): string | undefined {
  const origin = originLinkByConversationId.value.get(entry.id);
  if (origin?.originKind === 'agent') return origin.sourceKind === 'toolCall' ? 'AI 触发' : 'Agent 创建';
  if (origin?.originKind === 'system') return '系统创建';
  return undefined;
}

function displayConversationTitle(entry: SidebarConversationHistoryEntry | undefined): string {
  return entry ? formatConversationTitle({ id: entry.id, title: entry.title }) : '';
}

function openConversationState(entry: SidebarConversationHistoryEntry): OpenConversationPanelRecord | undefined {
  return openConversations.value.find((item) => item.conversationId === entry.id);
}

function openConversationClass(entry: SidebarConversationHistoryEntry): string | undefined {
  const state = openConversationState(entry);
  if (!state) return undefined;
  return state.visible || state.active ? 'is-open-visible' : 'is-open-hidden';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(value: number | undefined): string {
  if (!value) return '未开始';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未开始';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function displayProjectUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'file:') return normalizeFilePath(decodeURIComponent(parsed.pathname));
  } catch {
    // keep raw uri
  }
  return uri || '';
}

function normalizeFilePath(path: string): string {
  if (!path) return '';
  const maybeDriveLetter = path.charAt(1);
  const maybeDriveSeparator = path.charAt(2);
  const hasWindowsDrivePrefix = path.charAt(0) === '/'
    && maybeDriveSeparator === ':'
    && maybeDriveLetter.toLowerCase() !== maybeDriveLetter.toUpperCase();
  return hasWindowsDrivePrefix ? path.slice(1) : path;
}

function middleEllipsis(value: string, maxLength: number): string {
  if (!value || value.length <= maxLength) return value || '';
  const keep = Math.max(4, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function scopeOptionKey(scopeKind: SidebarHistoryScopeKind, projectFolderUri?: string): string {
  return scopeKind === 'project' ? `project:${projectFolderUri ?? ''}` : scopeKind;
}

function ensureActiveScopeVisible(): void {
  const index = scopeOptions.value.findIndex((option) => option.key === activeScopeKey.value);
  if (index < 0) return;
  scopePageIndex.value = Math.floor(index / SCOPE_PAGE_SIZE);
}

function flattenVisibleHistoryNodes(
  roots: readonly ConversationHistoryTreeNode[],
  expandedIds: ReadonlySet<string>
): VisibleHistoryTreeNode[] {
  const result: VisibleHistoryTreeNode[] = [];
  const append = (node: ConversationHistoryTreeNode, depth: number): void => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && expandedIds.has(node.entry.id);
    result.push({
      entry: node.entry,
      ...(node.originLink ? { originLink: node.originLink } : {}),
      ...(node.parentConversationId ? { parentConversationId: node.parentConversationId } : {}),
      depth,
      visualDepth: Math.min(depth, MAX_VISUAL_TREE_DEPTH),
      childCount: node.children.length,
      hasChildren,
      expanded
    });
    if (!expanded) return;
    for (const child of node.children) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  return result;
}

function ensureActiveConversationAncestorsExpanded(): void {
  const activeConversationId = openConversations.value.find((item) => item.active)?.conversationId;
  if (!activeConversationId) {
    autoExpandedActiveConversationId = undefined;
    return;
  }
  if (activeConversationId === autoExpandedActiveConversationId) return;

  const nodeById = new Map(
    flattenConversationHistoryForest(historyForest.value).map((node) => [node.entry.id, node])
  );
  let node = nodeById.get(activeConversationId);
  if (!node) return;
  autoExpandedActiveConversationId = activeConversationId;

  const next = new Set(expandedConversationIds.value);
  let changed = false;
  while (node.parentConversationId) {
    if (!next.has(node.parentConversationId)) {
      next.add(node.parentConversationId);
      changed = true;
    }
    const parent = nodeById.get(node.parentConversationId);
    if (!parent) break;
    node = parent;
  }
  if (changed) expandedConversationIds.value = next;
}

function historyPageIdentity(history: ConversationHistoryPageRecord): string {
  const scope = history.scope.kind === 'project'
    ? `project:${history.scope.folderUri}`
    : history.scope.kind;
  return `${scope}:${history.pageInfo.cursor ?? history.pageInfo.pageIndex}`;
}

function historyNodeStyle(node: VisibleHistoryTreeNode): Record<string, string> {
  return { '--history-tree-depth': String(node.visualDepth) };
}
</script>

<template>
  <main class="sidebar-shell">
    <section v-if="view === 'history'" class="view history-view" aria-label="对话历史">
      <div class="section-head">
        <div class="section-title-row">
          <div class="section-title-main">
            <div class="section-title">对话历史</div>
            <div class="section-count">{{ historyCountText }}</div>
          </div>
          <button type="button" class="icon-button settings-entry-button" title="设置" aria-label="设置" @click="setView('settings')">
            <IconAdjustmentsAlt class="settings-gear-icon" stroke="2" aria-hidden="true" />
          </button>
        </div>
        <div class="toolbar">
          <button type="button" class="primary-button" title="新建对话" @click="startNewConversation">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            新对话
          </button>
        </div>
        <div class="history-scope-pager" aria-label="对话历史范围分页列表">
          <button
            type="button"
            class="scope-page-button"
            :disabled="!canPreviousScopePage"
            aria-label="上一组范围"
            title="上一组范围"
            @click="previousScopePage"
          >
            ‹
          </button>
          <div class="scope-viewport">
            <div class="scope-track" :style="scopeTrackStyle" role="tablist" aria-label="对话历史范围">
              <div v-for="(page, pageIndex) in pagedScopeOptions" :key="pageIndex" class="scope-list">
                <button
                  v-for="option in page"
                  :key="option.key"
                  type="button"
                  class="scope-tab"
                  :class="{ active: activeScopeKey === option.key }"
                  :title="option.description || option.label"
                  @click="switchScope(option)"
                >
                  <span class="scope-tab-label">{{ option.label }}</span>
                  <span v-if="option.description" class="scope-tab-desc">{{ option.description }}</span>
                </button>
              </div>
            </div>
            <span class="scope-indicator" :style="scopeIndicatorStyle" aria-hidden="true"></span>
          </div>
          <button
            type="button"
            class="scope-page-button"
            :disabled="!canNextScopePage"
            aria-label="下一组范围"
            title="下一组范围"
            @click="nextScopePage"
          >
            ›
          </button>
        </div>
      </div>

      <div class="history-list-shell">
        <div ref="historyList" class="history-list" role="tree" aria-label="分级对话历史">
          <div
            v-for="node in visibleHistoryNodes"
            :key="node.entry.id"
            class="history-item"
            :class="[
              { 'is-running': node.entry.isRunning, 'is-tree-child': node.depth > 0 },
              openConversationClass(node.entry)
            ]"
            :style="historyNodeStyle(node)"
            role="treeitem"
            tabindex="0"
            :data-conversation-id="node.entry.id"
            :aria-level="node.depth + 1"
            :aria-expanded="node.hasChildren ? node.expanded : undefined"
            :aria-label="`打开对话：${displayConversationTitle(node.entry)}`"
            @click="openConversation(node.entry)"
            @keydown="onHistoryItemKeydown($event, node)"
          >
            <span class="history-tree-guides" aria-hidden="true">
              <span
                v-for="level in node.visualDepth"
                :key="level"
                class="history-tree-guide"
                :style="{ left: `${11 + (level - 1) * 16}px` }"
              ></span>
            </span>
            <span class="history-open-strip" aria-hidden="true"></span>
            <button
              v-if="node.hasChildren"
              type="button"
              class="history-disclosure-button"
              tabindex="-1"
              :aria-label="`${node.expanded ? '折叠' : '展开'}“${displayConversationTitle(node.entry)}”的 ${node.childCount} 个子对话`"
              @click.stop="toggleHistoryNode(node)"
            >
              <IconChevronRight
                class="history-disclosure-icon lc-collapse-chevron"
                :class="{ 'is-expanded': node.expanded }"
                stroke="2"
                aria-hidden="true"
              />
            </button>
            <span v-else class="history-disclosure-placeholder" aria-hidden="true"></span>
            <div class="history-status" :aria-label="statusText(node.entry)">
              <span class="status-dot" :class="statusClass(node.entry)" aria-hidden="true"></span>
              <span class="history-status-tooltip" role="tooltip">{{ statusText(node.entry) }}</span>
            </div>
            <div class="history-main">
              <div class="history-title-row">
                <div class="history-title">{{ displayConversationTitle(node.entry) }}</div>
                <span v-if="originBadgeText(node.entry)" class="origin-badge">{{ originBadgeText(node.entry) }}</span>
              </div>
              <div class="history-preview" :class="{ 'is-pending': node.entry.previewState === 'pending', 'is-empty': node.entry.previewState === 'empty' }">{{ node.entry.preview || '暂无消息，点击继续对话。' }}</div>
              <div class="history-meta">
                <span>{{ historyMeta(node.entry) }}</span>
                <span v-if="node.entry.isRunning" class="run-badge" :aria-label="`后台任务：${node.entry.runStatusLabel || '执行中'}`">
                  <span class="run-badge-dot" aria-hidden="true"></span>
                  <span>{{ node.entry.runStatusLabel || '执行中' }}</span>
                </span>
              </div>
            </div>
            <div class="history-actions" @click.stop @keydown.stop>
              <button type="button" class="history-action-button" title="重命名对话标题" aria-label="重命名对话标题" @click="renameConversation(node.entry)">
                <IconEdit class="history-action-icon" stroke="2" aria-hidden="true" />
              </button>
              <button type="button" class="history-action-button" title="删除对话" aria-label="删除对话" @click="deleteConversation(node.entry)">
                <IconTrash class="history-action-icon" stroke="2" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="history-action-button"
                :class="{ 'is-hidden': !node.entry.isRunning }"
                :disabled="!node.entry.isRunning"
                :aria-hidden="!node.entry.isRunning"
                :tabindex="node.entry.isRunning ? 0 : -1"
                title="终止后台任务"
                aria-label="终止后台任务"
                @click="node.entry.isRunning && abortConversation(node.entry)"
              >
                <IconPlayerStop class="history-action-icon" stroke="2" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        <AdvancedScrollbar
          class="history-edge-scrollbar"
          :scroller="historyList"
          :refresh-key="historyScrollbarRefreshKey"
        />
      </div>

      <div v-if="!entries.length" class="empty-state">
        <p class="empty-state-title">暂无对话历史</p>
        <p class="empty-state-desc">点击“新对话”创建一个独立会话空间。</p>
      </div>

      <div class="history-pagination" aria-label="对话历史分页">
        <button type="button" class="secondary-button" :disabled="!pageInfo?.hasPrevious" @click="previousPage">上一页</button>
        <span>第 {{ (pageInfo?.pageIndex ?? 0) + 1 }} 页</span>
        <button type="button" class="secondary-button" :disabled="!pageInfo?.hasNext" @click="nextPage">下一页</button>
      </div>
    </section>

    <section v-else-if="view === 'projectPicker'" class="view project-picker-view" aria-label="选择新对话归属项目">
      <div class="settings-head">
        <button type="button" class="back-button" title="返回对话历史" aria-label="返回对话历史" @click="setView('history')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="settings-heading">
          <div class="settings-title">选择项目</div>
          <div class="settings-desc">新对话将绑定到所选根文件夹</div>
        </div>
      </div>
      <div class="settings-content">
        <p class="project-picker-intro">当前是多根工作区，请选择这个新对话属于哪个项目。</p>
        <div class="project-folder-list">
          <button
            v-for="folder in projectFolders"
            :key="folder.uri"
            type="button"
            class="project-folder-button"
            :title="displayProjectUri(folder.uri)"
            :aria-label="`选择项目：${folder.name}`"
            @click="createNewConversation(folder.uri)"
          >
            <span>{{ folder.name || displayProjectUri(folder.uri) }}</span>
            <span class="project-folder-path">{{ middleEllipsis(displayProjectUri(folder.uri), 72) }}</span>
          </button>
        </div>
        <div v-if="!projectFolders.length" class="empty-state">
          <p class="empty-state-title">暂无可选项目</p>
          <p class="empty-state-desc">当前窗口没有打开的工作区文件夹。</p>
        </div>
      </div>
    </section>

    <section v-else class="view settings-view" aria-label="设置导航">
      <div class="settings-head">
        <button type="button" class="back-button" title="返回对话历史" aria-label="返回对话历史" @click="setView('history')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="settings-heading">
          <div class="settings-title">设置</div>
          <div class="settings-desc">选择要配置的范围</div>
        </div>
      </div>

      <div class="settings-content">
        <p class="settings-nav-intro">这个入口只负责导航到不同设置范围，具体配置仍在各自设置页中完成。</p>

        <nav class="settings-nav-list" aria-label="设置范围">
          <button type="button" class="settings-nav-card" @click="openGlobalSettings">
            <span class="settings-nav-icon" aria-hidden="true">
              <IconSettings class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">全局设置</span>
              <span class="settings-nav-desc">模型渠道、工具权限、数据目录与默认行为。</span>
            </span>
            <span class="settings-nav-trail">
              打开
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </button>

          <button type="button" class="settings-nav-card" @click="openAgentSettings">
            <span class="settings-nav-icon" aria-hidden="true">
              <IconRobot class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">Agent 设置</span>
              <span class="settings-nav-desc">角色、人格 Prompt、能力上限与默认模型。</span>
            </span>
            <span class="settings-nav-trail">
              打开
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </button>

          <button type="button" class="settings-nav-card" @click="openWorkflowSettings">
            <span class="settings-nav-icon" aria-hidden="true">
              <IconListDetails class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">工作流编辑</span>
              <span class="settings-nav-desc">查看和编辑内置工作流、用户工作流的原始数据。</span>
            </span>
            <span class="settings-nav-trail">
              打开
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </button>

          <button type="button" class="settings-nav-card is-disabled" disabled>
            <span class="settings-nav-icon" aria-hidden="true">
              <IconMessage class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">对话设置</span>
              <span class="settings-nav-desc">单个对话的名称、模型选择、工具策略与上下文配置。</span>
            </span>
            <span class="settings-nav-badge">即将支持</span>
          </button>
        </nav>

        <div class="settings-actions">
          <button type="button" class="secondary-button" @click="setView('history')">返回对话历史</button>
        </div>
      </div>
    </section>

    <InputPanel
      :open="isRenameDialogOpen"
      title="重命名对话"
      :description="renameDialogDescription"
      label="对话标题"
      :initial-value="renameInitialTitle"
      placeholder="输入新的对话标题"
      confirm-label="保存"
      @confirm="confirmRenameConversation"
      @cancel="closeRenameDialog"
    />

    <ConfirmPanel
      :open="isDeleteDialogOpen"
      title="删除对话？"
      :description-html="deleteDialogDescriptionHtml"
      :actions="deleteConfirmActions"
      @confirm="confirmDeleteConversation"
      @cancel="closeDeleteDialog"
    />

    <ConfirmPanel
      :open="isAbortDialogOpen"
      title="终止后台任务？"
      :description-html="abortDialogDescriptionHtml"
      :actions="abortConfirmActions"
      @confirm="confirmAbortConversation"
      @cancel="closeAbortDialog"
    />
  </main>
</template>
