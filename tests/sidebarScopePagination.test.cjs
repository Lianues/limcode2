const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sidebarHistoryContentState,
  sidebarScopePageIndexAfterState
} = require('../dist/extension/shared/sidebarScopePagination.js');

test('历史首次响应前显示加载态而不是空状态', () => {
  assert.equal(sidebarHistoryContentState(true, 0), 'loading');
  assert.equal(sidebarHistoryContentState(false, 0), 'empty');
  assert.equal(sidebarHistoryContentState(false, 3), 'list');
});

test('流式内容刷新且 active scope 未变化时保留用户手动切换的范围页', () => {
  assert.equal(sidebarScopePageIndexAfterState({
    currentPageIndex: 1,
    pageSize: 3,
    activeOptionIndex: 0,
    hasReceivedState: true,
    previousActiveScopeKey: 'currentProject',
    nextActiveScopeKey: 'currentProject'
  }), 1);
});

test('首次状态或 active scope 真正变化时定位到 active scope 所在页', () => {
  assert.equal(sidebarScopePageIndexAfterState({
    currentPageIndex: 0,
    pageSize: 3,
    activeOptionIndex: 4,
    hasReceivedState: false,
    previousActiveScopeKey: 'currentProject',
    nextActiveScopeKey: 'project:file:///b'
  }), 1);
  assert.equal(sidebarScopePageIndexAfterState({
    currentPageIndex: 0,
    pageSize: 3,
    activeOptionIndex: 5,
    hasReceivedState: true,
    previousActiveScopeKey: 'all',
    nextActiveScopeKey: 'project:file:///c'
  }), 1);
});
