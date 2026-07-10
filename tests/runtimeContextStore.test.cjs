const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const BridgeMessageType = {
  RuntimeContextScopeSet: 'runtimeContext.scope.set',
  RuntimeContextScopeClear: 'runtimeContext.scope.clear',
  RuntimeContextRefresh: 'runtimeContext.refresh',
  RuntimeContextSnapshotClear: 'runtimeContext.snapshot.clear'
};

function createRuntimeContextStoreHarness() {
  const requests = [];
  const clientState = {
    promptPlaceholders: [],
    runtimeContexts: [],
    runtimeContextScopeLinks: [],
    runtimeContextSnapshots: [],
    conversationRuntimeContextSnapshotLinks: []
  };
  const sourcePath = path.join(__dirname, '..', 'webview', 'src', 'stores', 'useRuntimeContextStore.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    }
  }).outputText;
  const moduleRecord = { exports: {} };

  function testRequire(specifier) {
    switch (specifier) {
      case 'pinia':
        return { defineStore: (_id, definition) => definition };
      case '@shared/protocol':
        return { BridgeMessageType };
      case '@webview/transport':
        return {
          bridge: {
            request(type, payload) {
              requests.push({ type, payload });
              return `request-${requests.length}`;
            }
          }
        };
      case './useClientStateStore':
        return { useClientStateStore: () => clientState };
      default:
        throw new Error(`Unexpected test import: ${specifier}`);
    }
  }

  const execute = new Function('require', 'module', 'exports', compiled);
  execute(testRequire, moduleRecord, moduleRecord.exports);
  const definition = moduleRecord.exports.useRuntimeContextStore;
  const store = { ...definition.state() };
  for (const [name, action] of Object.entries(definition.actions)) {
    store[name] = action.bind(store);
  }

  return { store, clientState, requests };
}

test('运行时模板在对应 ClientState 更新后结束保存状态', () => {
  const { store, clientState, requests } = createRuntimeContextStoreHarness();

  store.setContextForScope('agent', ' agent-main ', '\n  Agent runtime template  \n', ' Agent Runtime ');

  assert.equal(store.status, '正在保存运行时模板...');
  assert.equal(store.pendingSave.scopeId, 'agent-main');
  assert.equal(store.pendingSave.template, 'Agent runtime template');
  assert.deepEqual(requests, [{
    type: BridgeMessageType.RuntimeContextScopeSet,
    payload: {
      scopeKind: 'agent',
      scopeId: 'agent-main',
      template: 'Agent runtime template',
      name: 'Agent Runtime'
    }
  }]);

  clientState.runtimeContexts = [{ id: 'runtime-agent-main', template: 'Agent runtime template' }];
  clientState.runtimeContextScopeLinks = [{
    id: 'runtime-link-agent-main',
    scopeKind: 'agent',
    scopeId: 'agent-main',
    runtimeContextId: 'runtime-agent-main',
    role: 'active',
    createdAt: store.pendingSave.requestedAt,
    updatedAt: store.pendingSave.requestedAt
  }];

  store.reconcilePendingSave();

  assert.equal(store.pendingSave, undefined);
  assert.equal(store.status, '运行时模板已同步');
});

test('内容不匹配或更新时间过旧时不会提前结束保存状态', () => {
  const { store, clientState } = createRuntimeContextStoreHarness();
  store.setContextForScope('agent', 'agent-main', 'new template');
  const requestedAt = store.pendingSave.requestedAt;

  clientState.runtimeContexts = [{ id: 'runtime-agent-main', template: 'old template' }];
  clientState.runtimeContextScopeLinks = [{
    id: 'runtime-link-agent-main',
    scopeKind: 'agent',
    scopeId: 'agent-main',
    runtimeContextId: 'runtime-agent-main',
    role: 'active',
    createdAt: requestedAt - 1,
    updatedAt: requestedAt
  }];
  store.reconcilePendingSave();
  assert.notEqual(store.pendingSave, undefined);
  assert.equal(store.status, '正在保存运行时模板...');

  clientState.runtimeContexts[0].template = 'new template';
  clientState.runtimeContextScopeLinks[0].updatedAt = requestedAt - 1;
  store.reconcilePendingSave();
  assert.notEqual(store.pendingSave, undefined);
  assert.equal(store.status, '正在保存运行时模板...');

  clientState.runtimeContextScopeLinks[0].updatedAt = requestedAt;
  store.reconcilePendingSave();
  assert.equal(store.pendingSave, undefined);
  assert.equal(store.status, '运行时模板已同步');
});

test('无效作用域或空模板不会发起保存请求', () => {
  const { store, requests } = createRuntimeContextStoreHarness();

  store.setContextForScope('agent', '  ', 'template');
  assert.equal(store.status, '缺少运行时模板作用域，无法保存。');

  store.setContextForScope('global', undefined, '   ');
  assert.equal(store.status, '全局运行时模板不能为空。');
  assert.equal(requests.length, 0);
});
