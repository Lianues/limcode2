const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_SIDEBAR_HISTORY_SCOPE_KIND
} = require('../dist/extension/shared/protocol.js');

test('侧边栏默认打开当前项目范围', () => {
  assert.equal(DEFAULT_SIDEBAR_HISTORY_SCOPE_KIND, 'currentProject');
});
