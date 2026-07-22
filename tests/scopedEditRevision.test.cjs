const assert = require('node:assert/strict');
const test = require('node:test');
const { ScopedEditRevision } = require('../dist/extension/shared/scopedEditRevision.js');

test('快速模型切换时迟到的旧请求修订会被识别为 stale', () => {
  const revisions = new ScopedEditRevision();
  const readRevision = revisions.current('conversation-1');
  const firstSwitch = revisions.next('conversation-1');
  const secondSwitch = revisions.next('conversation-1');

  assert.equal(readRevision, 0);
  assert.equal(firstSwitch, 1);
  assert.equal(secondSwitch, 2);
  assert.equal(revisions.isStale('conversation-1', readRevision), true);
  assert.equal(revisions.isStale('conversation-1', firstSwitch), true);
  assert.equal(revisions.isStale('conversation-1', secondSwitch), false);
  assert.equal(revisions.isStale('conversation-2', 0), false, '不同对话的修订必须相互独立');
});
