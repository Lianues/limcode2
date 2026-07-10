const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildConversationHistoryForest,
  flattenConversationHistoryForest,
  packConversationHistoryForestIntoPages
} = require('../dist/extension/shared/conversationHistoryTree.js');

function entry(id, updatedAt) {
  return {
    id,
    title: id,
    preview: '',
    messageCount: 0,
    status: 'empty',
    isRunning: false,
    updatedAt
  };
}

function originLink(id, childConversationId, parentConversationId, createdAt = 1) {
  return {
    id,
    conversationId: childConversationId,
    originKind: 'agent',
    sourceKind: 'toolCall',
    sourceConversationId: parentConversationId,
    createdAt,
    updatedAt: createdAt
  };
}

test('构建多级会话树，并按整棵子树的最近活动排序根节点', () => {
  const forest = buildConversationHistoryForest(
    [entry('root', 1), entry('child', 3), entry('grandchild', 5), entry('other', 4)],
    [originLink('link-child', 'child', 'root'), originLink('link-grandchild', 'grandchild', 'child')]
  );

  assert.deepEqual(forest.map((node) => node.entry.id), ['root', 'other']);
  assert.deepEqual(
    flattenConversationHistoryForest([forest[0]]).map((node) => node.entry.id),
    ['root', 'child', 'grandchild']
  );
  assert.equal(forest[0].latestUpdatedAt, 5);
});

test('分页不拆分根会话树，超大单树允许独占超限页', () => {
  const forest = buildConversationHistoryForest(
    [
      entry('root-a', 9),
      entry('child-a', 8),
      entry('grandchild-a', 7),
      entry('root-b', 6),
      entry('child-b', 5),
      entry('root-c', 4)
    ],
    [
      originLink('link-a', 'child-a', 'root-a'),
      originLink('link-aa', 'grandchild-a', 'child-a'),
      originLink('link-b', 'child-b', 'root-b')
    ]
  );

  const pages = packConversationHistoryForestIntoPages(forest, 4);
  assert.deepEqual(
    pages.map((page) => page.map((node) => node.entry.id)),
    [
      ['root-a', 'child-a', 'grandchild-a'],
      ['root-b', 'child-b', 'root-c']
    ]
  );

  const oversized = packConversationHistoryForestIntoPages([forest[0]], 2);
  assert.deepEqual(oversized.map((page) => page.length), [3]);
});

test('孤儿、自引用和循环来源关系不会隐藏历史条目', () => {
  const forest = buildConversationHistoryForest(
    [entry('a', 1), entry('b', 2), entry('orphan', 3), entry('self', 4)],
    [
      originLink('link-a', 'a', 'b'),
      originLink('link-b', 'b', 'a'),
      originLink('link-orphan', 'orphan', 'missing'),
      originLink('link-self', 'self', 'self')
    ]
  );
  const ids = flattenConversationHistoryForest(forest).map((node) => node.entry.id);

  assert.equal(ids.length, 4);
  assert.deepEqual(new Set(ids), new Set(['a', 'b', 'orphan', 'self']));
});
