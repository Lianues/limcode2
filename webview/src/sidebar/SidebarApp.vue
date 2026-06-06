<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconEdit, IconSquare, IconTrash } from '@tabler/icons-vue';
import type { ConversationHistoryPageInfo } from '@shared/protocol';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
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

const PAGE_SIZE = 50;
const SCOPE_PAGE_SIZE = 3;
const view = ref<SidebarView>('history');
const entries = ref<SidebarConversationHistoryEntry[]>([]);
const projectFolders = ref<ProjectFolderCandidateRecord[]>([]);
const activeScopeKind = ref<SidebarHistoryScopeKind>('currentProject');
const activeProjectFolderUri = ref<string | undefined>();
const currentProjectScope = ref<ConversationHistoryScope>({ kind: 'unbound' });
const pageInfo = ref<ConversationHistoryPageInfo>();
const scopePageIndex = ref(0);
const renameTarget = ref<SidebarConversationHistoryEntry>();
const deleteTarget = ref<SidebarConversationHistoryEntry>();
const abortTarget = ref<SidebarConversationHistoryEntry>();
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
    { key: 'all', label: '全部', scopeKind: 'all' }
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

  options.push({ key: 'unbound', label: '未绑定', scopeKind: 'unbound' });
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

onMounted(() => {
  disposeMessages = onSidebarMessage((message) => {
    if (message.type !== SIDEBAR_MESSAGE.state) return;
    const nextScopeKind = message.activeScopeKind ?? activeScopeKind.value;
    entries.value = Array.isArray(message.history?.entries) ? message.history.entries : [];
    pageInfo.value = message.history?.pageInfo;
    activeScopeKind.value = nextScopeKind;
    if (message.activeProjectFolderUri !== undefined) activeProjectFolderUri.value = message.activeProjectFolderUri;
    else if (nextScopeKind !== 'project') activeProjectFolderUri.value = undefined;
    currentProjectScope.value = message.currentProjectScope ?? currentProjectScope.value;
    projectFolders.value = Array.isArray(message.projectFolders) ? message.projectFolders : [];
    ensureActiveScopeVisible();
  });
  postSidebarMessage({ type: SIDEBAR_MESSAGE.ready });
});

onBeforeUnmount(() => {
  disposeMessages?.();
});

function setView(next: SidebarView): void {
  view.value = next;
}

function openConversation(conversationId: string): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openConversation, conversationId });
}

function requestHistoryPage(
  scopeKind: SidebarHistoryScopeKind = activeScopeKind.value,
  cursor?: string,
  projectFolderUri = activeProjectFolderUri.value
): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.historyPageGet, scopeKind, projectFolderUri, cursor, limit: PAGE_SIZE });
}

function refreshHistory(): void {
  requestHistoryPage(activeScopeKind.value, pageInfo.value?.cursor, activeProjectFolderUri.value);
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

function onHistoryItemKeydown(event: KeyboardEvent, conversationId: string): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  openConversation(conversationId);
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

function displayConversationTitle(entry: SidebarConversationHistoryEntry | undefined): string {
  return entry?.title || entry?.id || '';
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
          <button type="button" class="icon-button" title="全局设置" aria-label="全局设置" @click="setView('settings')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
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
          <button type="button" class="secondary-button" title="刷新对话历史" aria-label="刷新对话历史" @click="refreshHistory">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path>
            </svg>
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

      <div class="history-list">
        <div
          v-for="entry in entries"
          :key="entry.id"
          class="history-item"
          :class="{ 'is-running': entry.isRunning }"
          role="button"
          tabindex="0"
          :title="`打开对话：${entry.title || entry.id}`"
          :aria-label="`打开对话：${entry.title || entry.id}`"
          @click="openConversation(entry.id)"
          @keydown="onHistoryItemKeydown($event, entry.id)"
        >
          <div class="history-avatar" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
          <div class="history-main">
            <div class="history-title-row">
              <div class="history-title">{{ entry.title || entry.id }}</div>
              <span class="status-dot" :class="statusClass(entry)" :title="statusText(entry)"></span>
            </div>
            <div class="history-preview">{{ entry.preview || '暂无消息，点击继续对话。' }}</div>
            <div class="history-meta">
              <span>{{ historyMeta(entry) }}</span>
              <span v-if="entry.isRunning" class="run-badge" :title="`后台任务：${entry.runStatusLabel || '执行中'}`">
                <span class="run-badge-dot" aria-hidden="true"></span>
                <span>{{ entry.runStatusLabel || '后台执行中' }}</span>
              </span>
            </div>
          </div>
          <div class="history-actions" @click.stop @keydown.stop>
            <button v-if="entry.isRunning" type="button" class="history-action-button" title="终止后台任务" aria-label="终止后台任务" @click="abortConversation(entry)">
              <IconSquare class="history-action-icon" stroke="2" aria-hidden="true" />
            </button>
            <button type="button" class="history-action-button" title="重命名对话标题" aria-label="重命名对话标题" @click="renameConversation(entry)">
              <IconEdit class="history-action-icon" stroke="2" aria-hidden="true" />
            </button>
            <button type="button" class="history-action-button" title="删除对话" aria-label="删除对话" @click="deleteConversation(entry)">
              <IconTrash class="history-action-icon" stroke="2" aria-hidden="true" />
            </button>
          </div>
        </div>
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

    <section v-else class="view settings-view" aria-label="全局设置">
      <div class="settings-head">
        <button type="button" class="back-button" title="返回对话历史" aria-label="返回对话历史" @click="setView('history')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="settings-heading">
          <div class="settings-title">全局设置</div>
          <div class="settings-desc">模型、密钥、数据目录与默认行为</div>
        </div>
      </div>

      <div class="settings-content">
        <article class="settings-card">
          <h3 class="settings-card-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2v20"></path><path d="M5 9h14"></path><path d="M5 15h14"></path>
            </svg>
            模型与 API
          </h3>
          <p class="settings-card-desc">配置默认 LLM Provider、模型名称、Base URL 和 API Key。</p>
          <div class="settings-grid">
            <div class="setting-row"><span>配置范围</span><strong>全局默认</strong></div>
            <div class="setting-row"><span>优先级</span><strong>可被对话设置覆盖</strong></div>
          </div>
        </article>

        <article class="settings-card">
          <h3 class="settings-card-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7h18"></path><path d="M5 7v12h14V7"></path><path d="M9 11h6"></path>
            </svg>
            数据与存储
          </h3>
          <p class="settings-card-desc">管理 LimCode 数据根目录，保持 Agent、Conversation 与 Link 独立存储。</p>
          <div class="settings-grid">
            <div class="setting-row"><span>存储结构</span><strong>ECS 解耦</strong></div>
            <div class="setting-row"><span>主题适配</span><strong>跟随 VS Code</strong></div>
          </div>
        </article>

        <div class="settings-actions">
          <button type="button" class="primary-button" @click="openGlobalSettings">打开完整设置面板</button>
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
