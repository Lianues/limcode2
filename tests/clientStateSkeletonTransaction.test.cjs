const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
}

function installVscodeMock() {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        delete: (uri, options = {}) => fs.rm(uri.fsPath, { recursive: !!options.recursive, force: false }),
        readFile: (uri) => fs.readFile(uri.fsPath),
        writeFile: async (uri, data) => {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, data);
        }
      }
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mock;
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => { Module._load = originalLoad; };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function addBundle(state, suffix) {
  state.conversations.push({ id: `conversation-${suffix}`, title: suffix, visibility: 'visible' });
  state.agents.push({ id: `agent-${suffix}`, name: suffix, kind: 'main', createdAt: 1, updatedAt: 1 });
  state.agentConversationLinks.push({
    id: `link-${suffix}`,
    agentId: `agent-${suffix}`,
    conversationId: `conversation-${suffix}`,
    role: 'default'
  });
  return state;
}

function setDeferredProject(state, suffix) {
  state.projectContexts = [{
    id: `project-${suffix}`,
    kind: 'workspaceFolder',
    uri: `file:///project-${suffix}`,
    name: suffix,
    createdAt: 1,
    updatedAt: 1
  }];
  return state;
}

function localWorkspaceEnvironment(overrides = {}) {
  return {
    id: 'work-env-local-same',
    kind: 'localFolder',
    source: 'workspaceFolder',
    name: 'Project',
    uri: 'file:///project',
    rootPath: '/project',
    displayPath: '/project',
    available: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

const restore = installVscodeMock();
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const skeletonTransaction = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonTransaction.js');
const skeletonPatch = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonPatch.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { STORAGE_VERSION } = require('../dist/extension/backend/capabilities/vscodeStorage/constants.js');

async function commitState(paths, base, next) {
  return clientStateStore.saveClientStateSkeletonToStores(paths, skeletonPatch.createClientStateSkeletonPatch(base, next));
}

async function loadPinned(paths, pin, profile = 'full') {
  return clientStateStore.loadClientStateSkeletonSnapshotFromStores(paths, pin, { profile });
}

async function loadCurrent(paths, owner = 'test-current') {
  const pin = await skeletonTransaction.openClientStateSkeletonSnapshot(paths, owner);
  if (!pin) return undefined;
  try {
    return await loadPinned(paths, pin, 'full');
  } finally {
    await skeletonTransaction.releaseClientStateSkeletonSnapshot(paths, pin);
  }
}

async function withTemp(prefix, action) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await action(createVscodeStoragePaths(MockUri.file(tempRoot)), tempRoot);
  } finally {
    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterPhase = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('不同窗口基于同一 base 新增不同 Conversation/Link，最终 committed snapshot 取 union', async () => {
  await withTemp('limcode-skeleton-union-', async (paths) => {
    const base = addBundle(createEmptyClientState(), 'base');
    await commitState(paths, createEmptyClientState(), base);

    const windowA = addBundle(clone(base), 'A');
    const windowB = addBundle(clone(base), 'B');
    await commitState(paths, base, windowA);
    await commitState(paths, base, windowB);

    const loaded = await loadCurrent(paths);
    assert.deepEqual(loaded.conversations.map((record) => record.id).sort(), [
      'conversation-A', 'conversation-B', 'conversation-base'
    ]);
    assert.deepEqual(loaded.agentConversationLinks.map((record) => record.id).sort(), [
      'link-A', 'link-B', 'link-base'
    ]);
  });
});

test('陈旧窗口只新增 Y 时不会复活已被另一窗口删除的 X', async () => {
  await withTemp('limcode-skeleton-delete-no-resurrect-', async (paths) => {
    const base = addBundle(createEmptyClientState(), 'X');
    await commitState(paths, createEmptyClientState(), base);
    const staleAddsY = addBundle(clone(base), 'Y');
    await commitState(paths, base, createEmptyClientState());
    await commitState(paths, base, staleAddsY);

    const loaded = await loadCurrent(paths);
    assert.deepEqual(loaded.conversations.map((record) => record.id), ['conversation-Y']);
    assert.deepEqual(loaded.agentConversationLinks.map((record) => record.id), ['link-Y']);
  });
});

test('同 id 分叉更新明确冲突，绝不静默 last-writer-wins', async () => {
  await withTemp('limcode-skeleton-conflict-', async (paths) => {
    const base = addBundle(createEmptyClientState(), 'same');
    await commitState(paths, createEmptyClientState(), base);
    const a = clone(base);
    const b = clone(base);
    a.conversations[0].title = 'A title';
    b.conversations[0].title = 'B title';
    await commitState(paths, base, a);
    await assert.rejects(
      () => commitState(paths, base, b),
      (error) => error && error.clientStateSkeletonRevisionConflict === true
    );
    assert.equal((await loadCurrent(paths)).conversations[0].title, 'A title');
  });
});
test('本地 workspaceFolder workEnvironment 并发 upsert 仅窗口态不同不冲突并规范化', async () => {
  await withTemp('limcode-skeleton-workenv-window-state-', async (paths) => {
    const base = createEmptyClientState();
    const windowA = createEmptyClientState();
    const windowB = createEmptyClientState();
    windowA.workEnvironments.push(localWorkspaceEnvironment({
      name: 'Project A',
      index: 0,
      available: true,
      createdAt: 100,
      updatedAt: 100
    }));
    windowB.workEnvironments.push(localWorkspaceEnvironment({
      name: 'Project B',
      available: false,
      createdAt: 200,
      updatedAt: 200
    }));

    await commitState(paths, base, windowA);
    await commitState(paths, base, windowB);

    const loaded = await loadCurrent(paths);
    assert.equal(loaded.workEnvironments.length, 1);
    assert.equal(loaded.workEnvironments[0].id, 'work-env-local-same');
    assert.equal(loaded.workEnvironments[0].uri, 'file:///project');
    assert.equal(loaded.workEnvironments[0].rootPath, '/project');
    assert.equal(loaded.workEnvironments[0].available, true);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.workEnvironments[0], 'index'), false);
  });
});


test('本地 workspaceFolder workEnvironment 稳定身份字段不同仍然冲突', async () => {
  await withTemp('limcode-skeleton-workenv-real-conflict-', async (paths) => {
    const base = createEmptyClientState();
    const windowA = createEmptyClientState();
    const windowB = createEmptyClientState();
    windowA.workEnvironments.push(localWorkspaceEnvironment({ rootPath: '/project-a', displayPath: '/project-a' }));
    windowB.workEnvironments.push(localWorkspaceEnvironment({ rootPath: '/project-b', displayPath: '/project-b' }));

    await commitState(paths, base, windowA);
    await assert.rejects(
      () => commitState(paths, base, windowB),
      (error) => error && error.clientStateSkeletonRevisionConflict === true
    );
    assert.equal((await loadCurrent(paths)).workEnvironments[0].rootPath, '/project-a');
  });
});


test('同语义 deterministic skeleton relation 仅时间戳不同应视为幂等并发提交', async () => {
  await withTemp('limcode-skeleton-semantic-idempotent-', async (paths) => {
    const base = createEmptyClientState();
    const windowA = createEmptyClientState();
    const windowB = createEmptyClientState();
    const conversationId = 'conversation-idempotent-selection';
    windowA.conversations.push({ id: conversationId, title: 'A', visibility: 'visible' });
    windowB.conversations.push({ id: conversationId, title: 'A', visibility: 'visible' });
    windowA.conversationWorkflowSelections.push({
      id: `conversation-workflow:global:${conversationId}`,
      conversationId,
      scopeKind: 'global',
      role: 'active',
      createdAt: 100,
      updatedAt: 100
    });
    windowB.conversationWorkflowSelections.push({
      id: `conversation-workflow:global:${conversationId}`,
      conversationId,
      scopeKind: 'global',
      role: 'active',
      createdAt: 200,
      updatedAt: 200
    });

    await commitState(paths, base, windowA);
    await commitState(paths, base, windowB);

    const loaded = await loadCurrent(paths);
    assert.deepEqual(loaded.conversationWorkflowSelections.map((item) => ({
      id: item.id,
      conversationId: item.conversationId,
      scopeKind: item.scopeKind,
      role: item.role
    })), [{
      id: `conversation-workflow:global:${conversationId}`,
      conversationId,
      scopeKind: 'global',
      role: 'active'
    }]);
  });
});



test('startup/deferred 使用同一 immutable pin，期间多次 commit 不会让 staged hydration 失败或漂移', async () => {
  await withTemp('limcode-skeleton-pin-', async (paths) => {
    const first = setDeferredProject(addBundle(createEmptyClientState(), 'first'), 'first');
    await commitState(paths, createEmptyClientState(), first);
    const pin = await skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'staged-reader');
    assert.ok(pin);

    const startup = await loadPinned(paths, pin, 'startup');
    const second = setDeferredProject(addBundle(createEmptyClientState(), 'second'), 'second');
    await commitState(paths, first, second);
    const third = clone(second);
    third.conversations[0].title = 'third';
    await commitState(paths, second, third);

    const deferred = await loadPinned(paths, pin, 'deferred');
    assert.deepEqual(startup.conversations.map((item) => item.id), ['conversation-first']);
    assert.deepEqual(deferred.projectContexts.map((item) => item.id), ['project-first']);
    await skeletonTransaction.releaseClientStateSkeletonSnapshot(paths, pin);

    const current = await loadCurrent(paths);
    assert.equal(current.conversations[0].title, 'third');
    assert.deepEqual(current.projectContexts.map((item) => item.id), ['project-second']);
  });
});

test('current pointer 发布前 crash 仍完整读取 old；发布后 crash 只读取完整 new', async () => {
  await withTemp('limcode-skeleton-crash-', async (paths) => {
    const oldState = addBundle(createEmptyClientState(), 'old');
    await commitState(paths, createEmptyClientState(), oldState);
    const beforePublish = clone(oldState);
    beforePublish.conversations[0].title = 'before-publish';

    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterPhase = async (phase) => {
      if (phase === 'snapshotWritten') throw new Error('crash-before-current');
    };
    await assert.rejects(() => commitState(paths, oldState, beforePublish), /crash-before-current/);
    assert.equal((await loadCurrent(paths)).conversations[0].title, 'old');

    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterPhase = undefined;
    const afterPublish = clone(oldState);
    afterPublish.conversations[0].title = 'after-current';
    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterPhase = async (phase) => {
      if (phase === 'currentWritten') throw new Error('crash-after-current');
    };
    await assert.rejects(() => commitState(paths, oldState, afterPublish), /crash-after-current/);
    assert.equal((await loadCurrent(paths)).conversations[0].title, 'after-current');
  });
});


test('派生共享 skeleton 首次提交在 storesPrepared 后中断时可安全清理并重新初始化', async () => {
  await withTemp('limcode-skeleton-initial-recovery-', async (paths) => {
    const interrupted = addBundle(createEmptyClientState(), 'interrupted');
    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterPhase = async (phase) => {
      if (phase === 'storesPrepared') throw new Error('crash-before-first-snapshot');
    };
    await assert.rejects(
      () => commitState(paths, createEmptyClientState(), interrupted),
      /crash-before-first-snapshot/
    );
    await assert.rejects(
      () => skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'strict-reader'),
      /pointer is missing while storage traces still exist/
    );

    const recovered = await skeletonTransaction.openClientStateSkeletonSnapshot(
      paths,
      'recovering-reader',
      { recoverAbandonedInitialCommit: true }
    );
    assert.equal(recovered, undefined);

    skeletonTransaction.__clientStateSkeletonTransactionTestHooks.afterPhase = undefined;
    const replacement = addBundle(createEmptyClientState(), 'replacement');
    await commitState(paths, createEmptyClientState(), replacement);
    assert.deepEqual((await loadCurrent(paths)).conversations.map((item) => item.id), ['conversation-replacement']);
  });
});


test('live pin 保护任意旧 generation；release 后后续 GC 可回收', async () => {
  await withTemp('limcode-skeleton-pin-gc-', async (paths) => {
    const one = addBundle(createEmptyClientState(), 'one');
    await commitState(paths, createEmptyClientState(), one);
    const pin = await skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'gc-reader');
    const pinnedManifestPath = path.join(paths.clientStateSkeletonRootPath, 'snapshots', `${pin.snapshotId}.json`);

    const two = clone(one); two.conversations[0].title = 'two';
    const three = clone(two); three.conversations[0].title = 'three';
    await commitState(paths, one, two);
    await commitState(paths, two, three);
    assert.equal((await loadPinned(paths, pin)).conversations[0].title, 'one');
    await fs.access(pinnedManifestPath);

    await skeletonTransaction.releaseClientStateSkeletonSnapshot(paths, pin);
    const four = clone(three); four.conversations[0].title = 'four';
    await commitState(paths, three, four);
    await assert.rejects(() => fs.access(pinnedManifestPath), /ENOENT/);
  });
});

test('GC 保留 fresh preparing marker 对应的 in-flight generation', async () => {
  await withTemp('limcode-skeleton-preparing-gc-', async (paths) => {
    const state = addBundle(createEmptyClientState(), 'base');
    await commitState(paths, createEmptyClientState(), state);

    const protectedGenerationId = '20260722-010203-004-00000001';
    const unprotectedGenerationId = '20260722-010203-005-00000002';
    const preparingRoot = path.join(paths.clientStateSkeletonRootPath, 'preparing');
    await fs.mkdir(preparingRoot, { recursive: true });
    await fs.writeFile(path.join(preparingRoot, `${protectedGenerationId}.json`), `${JSON.stringify({
      kind: 'clientStateSkeleton.preparing',
      schemaVersion: STORAGE_VERSION,
      snapshotId: protectedGenerationId,
      ownerPid: process.pid,
      startedAt: Date.now()
    }, null, 2)}\n`, 'utf8');

    const protectedRoot = path.join(paths.conversationOriginLinksRootPath, 'generations', protectedGenerationId);
    const unprotectedRoot = path.join(paths.conversationOriginLinksRootPath, 'generations', unprotectedGenerationId);
    await fs.mkdir(protectedRoot, { recursive: true });
    await fs.mkdir(unprotectedRoot, { recursive: true });

    await skeletonTransaction.garbageCollectClientStateSkeleton(paths);

    await fs.access(protectedRoot);
    await assert.rejects(() => fs.access(unprotectedRoot), /ENOENT/);
  });
});


test('语义化 Conversation 删除基于最新 union，能移除调用窗口未 hydrate 的外部 Link', async () => {
  await withTemp('limcode-skeleton-semantic-delete-', async (paths) => {
    const initial = addBundle(createEmptyClientState(), 'target');
    initial.conversationProjectLinks.push({
      id: 'external-project-link',
      conversationId: 'conversation-target',
      projectContextId: 'project-external',
      role: 'primary',
      createdAt: 1,
      updatedAt: 1
    });
    initial.projectContexts.push({
      id: 'project-external', kind: 'workspaceFolder', uri: 'file:///external', name: 'external', createdAt: 1, updatedAt: 1
    });
    await commitState(paths, createEmptyClientState(), initial);
    await skeletonTransaction.commitClientStateSkeletonConversationDeletion(paths, 'conversation-target');
    const loaded = await loadCurrent(paths);
    assert.equal(loaded.conversations.length, 0);
    assert.equal(loaded.agentConversationLinks.length, 0);
    assert.equal(loaded.conversationProjectLinks.length, 0);
    assert.equal(loaded.projectContexts.length, 1, '独立 ProjectContext 主体不能因 Link 删除而级联删除');
  });
});

test('current/previous 指针缺失但 generation traces 仍存在时 fail closed，不误判为空存储', async () => {
  await withTemp('limcode-skeleton-missing-pointer-', async (paths) => {
    const state = addBundle(createEmptyClientState(), 'pointer');
    await commitState(paths, createEmptyClientState(), state);
    await fs.rm(path.join(paths.clientStateSkeletonRootPath, 'current.json'));

    await assert.rejects(
      () => skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'missing-pointer-reader'),
      /pointer is missing while storage traces still exist/
    );
    await assert.rejects(
      () => commitState(paths, createEmptyClientState(), addBundle(createEmptyClientState(), 'replacement')),
      /pointer is missing while storage traces still exist/
    );
  });
});

test('空存储不创建 coordinator；open 返回 undefined', async () => {
  await withTemp('limcode-skeleton-empty-', async (paths) => {
    assert.equal(await skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'empty-reader'), undefined);
    await assert.rejects(
      () => fs.access(path.join(paths.clientStateSkeletonRootPath, 'current.json')),
      /ENOENT/
    );
  });
});

test('收尾恢复 vscode mock', () => restore());
